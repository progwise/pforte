import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, hasDatabase } from '../test/test-database.js'
import {
  activateUser,
  deactivateUser,
  endSessions,
  LifecycleError,
  type LifecycleAction,
  lockUser,
  requestPasswordReset,
  unlockUser,
} from './lifecycle.js'
import { createUser, deleteUser, findUserById } from './users.js'

const context = { actor: { type: 'client' as const, id: 'tester' }, ip: '203.0.113.7', userAgent: 'vitest' }
const STATUSES = ['created', 'active', 'locked', 'deactivated'] as const

describe.skipIf(!hasDatabase)('user lifecycle', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>
  let counter = 0

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  afterAll(async () => {
    await database?.drop()
  })

  const userIn = async (status: (typeof STATUSES)[number], { password = status !== 'created' } = {}) => {
    const created = await database.db.transaction((tx) =>
      createUser(tx, context, { email: `life${++counter}@example.com`, firstName: 'L', lastName: `${counter}` }),
    )
    await database.pool.query(`update users set status = $1, password_hash = $2 where id = $3`, [
      status,
      password ? 'hash' : null,
      created.id,
    ])
    return (await findUserById(database.db, created.id))!
  }
  const addSession = (accountId: string, id: string) =>
    database.pool.query(
      `insert into oidc_payloads (id, type, payload, account_id) values ($1, 1, '{}', $2)`,
      [id, accountId],
    )
  const sessionsOf = async (accountId: string) =>
    Number((await database.pool.query(`select count(*) from oidc_payloads where account_id = $1`, [accountId])).rows[0].count)
  const event = async (action: string, userId: string) =>
    (await database.pool.query(`select * from audit_events where action = $1 and target_id = $2`, [action, userId])).rows.at(-1)
  const run = (action: LifecycleAction, user: Awaited<ReturnType<typeof userIn>>) =>
    database.db.transaction(async (tx) => {
      switch (action) {
        case 'lock': return lockUser(tx, context, user)
        case 'unlock': return unlockUser(tx, context, user)
        case 'activate': return activateUser(tx, context, user)
        case 'deactivate': return deactivateUser(tx, context, user)
        case 'reset-password': return requestPasswordReset(tx, context, user)
        case 'end-sessions': return endSessions(tx, context, user)
      }
    })

  describe('transitions', () => {
    const allowed: Record<LifecycleAction, readonly string[]> = {
      lock: ['created', 'active'],
      unlock: ['locked', 'active'],
      activate: ['created', 'deactivated'],
      deactivate: ['created', 'active', 'locked'],
      'reset-password': ['active'],
      'end-sessions': ['created', 'active', 'locked', 'deactivated'],
    }
    const cases = (Object.keys(allowed) as LifecycleAction[]).flatMap((action) => STATUSES.map((status) => [action, status] as const))

    it.each(cases)('%s a user who is %s', async (action, status) => {
      const user = await userIn(status)

      if (allowed[action].includes(status)) {
        await expect(run(action, user)).resolves.toBeDefined()
      } else {
        await expect(run(action, user)).rejects.toBeInstanceOf(LifecycleError)
        // A refused action changes nothing.
        expect((await findUserById(database.db, user.id))!.status).toBe(status)
      }
    })

    it('names the states in which the action is possible', async () => {
      const user = await userIn('deactivated')

      await expect(run('unlock', user)).rejects.toThrow(/unlock a user who is deactivated.*locked, active/)
    })
  })

  describe('unlocking an active user', () => {
    it('changes nothing but is recorded, so an administrator can let someone in after too many mistakes', async () => {
      const user = await userIn('active')
      const unlocked = await run('unlock', user)

      expect(unlocked).toMatchObject({ id: user.id, status: 'active' })
      const { rows } = await database.pool.query(`select details from audit_events where action = 'user.unlock' and target_id = $1`, [user.id])
      expect(rows[0].details).toMatchObject({ from: 'active', to: 'active' })
    })
  })

  describe('locking and deactivating', () => {
    it('lock sets the status and time, and ends every session of that user only', async () => {
      const user = await userIn('active')
      const other = await userIn('active')
      await addSession(user.id, 'user-1')
      await addSession(user.id, 'user-2')
      await addSession(other.id, 'other-1')

      const { user: locked } = (await run('lock', user)) as Awaited<ReturnType<typeof lockUser>>

      expect(locked).toMatchObject({ status: 'locked' })
      expect(locked.lockedAt).toBeInstanceOf(Date)
      expect(await sessionsOf(user.id)).toBe(0)
      expect(await sessionsOf(other.id)).toBe(1)
      expect((await event('user.lock', user.id)).details).toMatchObject({ from: 'active', to: 'locked', sessionsEnded: 2 })
    })

    it('deactivate ends sessions and kills a pending activation link', async () => {
      const user = await userIn('created')
      await run('activate', user)
      await addSession(user.id, 'deact-1')

      const { user: deactivated } = (await run('deactivate', (await findUserById(database.db, user.id))!)) as Awaited<ReturnType<typeof deactivateUser>>

      expect(deactivated.status).toBe('deactivated')
      expect(deactivated.activationTokenHash).toBeNull()
      expect(deactivated.activationExpiresAt).toBeNull()
      expect(await sessionsOf(user.id)).toBe(0)
    })

    it('unlock returns a user with a password to active, and one without to created', async () => {
      const withPassword = await userIn('locked', { password: true })
      const withoutPassword = await userIn('locked', { password: false })
      await database.pool.query(`update users set locked_at = now() where id = any($1)`, [[withPassword.id, withoutPassword.id]])

      const a = (await run('unlock', (await findUserById(database.db, withPassword.id))!)) as Awaited<ReturnType<typeof userIn>>
      const b = (await run('unlock', (await findUserById(database.db, withoutPassword.id))!)) as Awaited<ReturnType<typeof userIn>>

      expect(a).toMatchObject({ status: 'active', lockedAt: null })
      expect(b).toMatchObject({ status: 'created', lockedAt: null })
    })
  })

  describe('activation', () => {
    const hash = (token: string) => createHash('sha256').update(token).digest('hex')

    it('issues a one-time token, stores only its hash and keeps it out of the audit log', async () => {
      const user = await userIn('created')

      const { user: updated, activation } = (await run('activate', user)) as Awaited<ReturnType<typeof activateUser>>

      expect(activation!.token.length).toBeGreaterThanOrEqual(43)
      expect(updated.status).toBe('created')
      expect(updated.activationTokenHash).toBe(hash(activation!.token))
      expect(updated.activationTokenHash).not.toContain(activation!.token)
      const days = (activation!.expiresAt.getTime() - Date.now()) / 86_400_000
      expect(days).toBeGreaterThan(6.9)
      expect(days).toBeLessThan(7.1)

      const logged = await event('user.activate', user.id)
      expect(JSON.stringify(logged)).not.toContain(activation!.token)
      expect(logged.details).toMatchObject({ linkSent: true })
    })

    it('replaces the earlier link when activation is started again', async () => {
      const user = await userIn('created')
      const first = (await run('activate', user)) as Awaited<ReturnType<typeof activateUser>>

      const second = (await run('activate', first.user)) as Awaited<ReturnType<typeof activateUser>>

      expect(second.activation!.token).not.toBe(first.activation!.token)
      expect(second.user.activationTokenHash).not.toBe(first.user.activationTokenHash)
    })

    it('reactivates a deactivated user who has a password without sending a link', async () => {
      const user = await userIn('deactivated', { password: true })

      const result = (await run('activate', user)) as Awaited<ReturnType<typeof activateUser>>

      expect(result.user.status).toBe('active')
      expect(result.activation).toBeUndefined()
      expect((await event('user.activate', user.id)).details).toMatchObject({ from: 'deactivated', to: 'active', linkSent: false })
    })

    it('sends a link to a deactivated user who never had a password', async () => {
      const user = await userIn('deactivated', { password: false })

      const result = (await run('activate', user)) as Awaited<ReturnType<typeof activateUser>>

      expect(result.user.status).toBe('created')
      expect(result.activation).toBeDefined()
    })
  })

  describe('password reset and ending sessions', () => {
    it('a password reset request ends the sessions of an active user and is recorded', async () => {
      const user = await userIn('active')
      await addSession(user.id, 'reset-1')

      await run('reset-password', user)

      expect(await sessionsOf(user.id)).toBe(0)
      expect((await event('user.password_reset.request', user.id)).details).toMatchObject({ sessionsEnded: 1 })
    })

    it('ending sessions reports how many rows went and leaves the status alone', async () => {
      const user = await userIn('locked')
      await addSession(user.id, 'end-1')
      await addSession(user.id, 'end-2')
      await addSession(user.id, 'end-3')

      const result = (await run('end-sessions', user)) as Awaited<ReturnType<typeof endSessions>>

      expect(result.sessionsEnded).toBe(3)
      expect((await findUserById(database.db, user.id))!.status).toBe('locked')
    })
  })

  describe('the applications to tell (back-channel logout)', () => {
    let clientCounter = 0
    /** A client, with a logout address unless told otherwise. */
    const client = async ({ address = true, sessionRequired = false } = {}) => {
      const clientId = `logout-client-${++clientCounter}`
      await database.pool.query(
        `insert into clients (client_id, name, type, backchannel_logout_uri, backchannel_logout_session_required) values ($1, $1, 'public', $2, $3)`,
        [clientId, address ? `https://${clientId}.example.com/logout` : null, sessionRequired],
      )
      return clientId
    }
    const record = (accountId: string, type: 1 | 13, payload: object, expires = `interval '1 hour'`) =>
      database.pool.query(`insert into oidc_payloads (id, type, payload, account_id, expires_at) values (gen_random_uuid()::text, $1, $2, $3, now() + ${expires})`, [
        type,
        JSON.stringify(payload),
        accountId,
      ])
    /** A browser session in which the user is signed in to these clients, each under its session ID. */
    const session = (accountId: string, sids: Record<string, string>, expires?: string) =>
      record(accountId, 1, { accountId, authorizations: Object.fromEntries(Object.entries(sids).map(([clientId, sid]) => [clientId, { sid, grantId: `grant-of-${sid}` }])) }, expires)
    /** What stays when an application keeps refreshing its tokens: the grant, without a browser session. */
    const grant = (accountId: string, clientId: string, expires?: string) => record(accountId, 13, { accountId, clientId }, expires)
    const end = async (user: Awaited<ReturnType<typeof userIn>>) => (await run('end-sessions', user)) as Awaited<ReturnType<typeof endSessions>>

    it('tells a client with a logout address once, however many sessions the user has with it', async () => {
      const user = await userIn('active')
      const listening = await client()
      const deaf = await client({ address: false })
      await session(user.id, { [listening]: 'sid-1', [deaf]: 'sid-2' })
      await session(user.id, { [listening]: 'sid-3' })
      await grant(user.id, listening)

      const { logouts } = await end(user)

      expect(logouts).toEqual([{ clientId: listening }])
      expect((await event('user.sessions.end', user.id)).details).toMatchObject({ sessionsEnded: 3, clientsToNotify: 1 })
    })

    it('tells a client that asked for the session ID once per session, with that ID', async () => {
      const user = await userIn('active')
      const strict = await client({ sessionRequired: true })
      await session(user.id, { [strict]: 'sid-b' })
      await session(user.id, { [strict]: 'sid-a' })

      const { logouts } = await end(user)

      expect(logouts).toEqual([
        { clientId: strict, sid: 'sid-a' },
        { clientId: strict, sid: 'sid-b' },
      ])
      // Two logout tokens, but one application.
      expect((await event('user.sessions.end', user.id)).details).toMatchObject({ clientsToNotify: 1 })
    })

    it('tells a client that only holds a grant, unless it asked for the session ID: there is none to name', async () => {
      const user = await userIn('active')
      const refreshing = await client()
      const strict = await client({ sessionRequired: true })
      await grant(user.id, refreshing)
      await grant(user.id, strict)

      const { logouts } = await end(user)

      expect(logouts).toEqual([{ clientId: refreshing }])
    })

    it('tells nobody about sessions and grants that have expired, or of another user', async () => {
      const user = await userIn('active')
      const other = await userIn('active')
      const past = await client()
      const theirs = await client()
      await session(user.id, { [past]: 'sid-old' }, `interval '-1 minute'`)
      await grant(user.id, past, `interval '-1 minute'`)
      await session(other.id, { [theirs]: 'sid-other' })

      const { logouts } = await end(user)

      expect(logouts).toEqual([])
      expect((await event('user.sessions.end', user.id)).details).toMatchObject({ clientsToNotify: 0 })
      // The other user's session is still there, and still to be told about.
      expect((await end(other)).logouts).toEqual([{ clientId: theirs }])
    })

    it('tells nobody when the user has no sessions', async () => {
      const user = await userIn('active')
      await client()
      expect((await end(user)).logouts).toEqual([])
    })

    it.each([
      ['lock', 'user.lock', 'active'],
      ['deactivate', 'user.deactivate', 'active'],
      ['reset-password', 'user.password_reset.request', 'active'],
      ['end-sessions', 'user.sessions.end', 'locked'],
    ] as const)('%s returns the logouts and records how many applications are to be told', async (action, recorded, status) => {
      const user = await userIn(status)
      const listening = await client()
      await session(user.id, { [listening]: 'sid-1' })

      const result = (await run(action, user)) as { logouts: unknown }

      expect(result.logouts).toEqual([{ clientId: listening }])
      expect((await event(recorded, user.id)).details).toMatchObject({ clientsToNotify: 1 })
      expect(await sessionsOf(user.id)).toBe(0)
    })

    it('deleting a user returns the logouts and records how many applications are to be told', async () => {
      const user = await userIn('active')
      const listening = await client()
      await session(user.id, { [listening]: 'sid-1' })

      const { logouts } = await database.db.transaction((tx) => deleteUser(tx, context, user))

      expect(logouts).toEqual([{ clientId: listening }])
      expect((await event('user.delete', user.id)).details).toMatchObject({ sessionsEnded: 1, clientsToNotify: 1 })
    })
  })

  it('deleting a user ends their sessions and says how many in the audit event', async () => {
    const user = await userIn('active')
    await addSession(user.id, 'del-1')

    await database.db.transaction((tx) => deleteUser(tx, context, user))

    expect(await sessionsOf(user.id)).toBe(0)
    expect((await event('user.delete', user.id)).details).toMatchObject({ email: user.email, sessionsEnded: 1 })
  })
})
