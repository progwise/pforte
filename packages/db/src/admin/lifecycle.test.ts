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
      unlock: ['locked'],
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
      const user = await userIn('active')

      await expect(run('unlock', user)).rejects.toThrow(/unlock a user who is active.*locked/)
    })
  })

  describe('locking and deactivating', () => {
    it('lock sets the status and time, and ends every session of that user only', async () => {
      const user = await userIn('active')
      const other = await userIn('active')
      await addSession(user.id, 'user-1')
      await addSession(user.id, 'user-2')
      await addSession(other.id, 'other-1')

      const locked = await run('lock', user)

      expect(locked).toMatchObject({ status: 'locked' })
      expect((locked as { lockedAt: Date }).lockedAt).toBeInstanceOf(Date)
      expect(await sessionsOf(user.id)).toBe(0)
      expect(await sessionsOf(other.id)).toBe(1)
      expect((await event('user.lock', user.id)).details).toMatchObject({ from: 'active', to: 'locked', sessionsEnded: 2 })
    })

    it('deactivate ends sessions and kills a pending activation link', async () => {
      const user = await userIn('created')
      await run('activate', user)
      await addSession(user.id, 'deact-1')

      const deactivated = (await run('deactivate', (await findUserById(database.db, user.id))!)) as Awaited<ReturnType<typeof userIn>>

      expect(deactivated.status).toBe('deactivated')
      expect(deactivated.activationTokenHash).toBeNull()
      expect(deactivated.activationExpiresAt).toBeNull()
      expect(await sessionsOf(user.id)).toBe(0)
    })

    it('unlock returns a user with a password to active, and one without to created', async () => {
      const withPassword = await userIn('locked', { password: true })
      const withoutPassword = await userIn('locked', { password: false })
      await database.pool.query(`update users set failed_login_attempts = 5, locked_at = now() where id = any($1)`, [[withPassword.id, withoutPassword.id]])

      const a = (await run('unlock', (await findUserById(database.db, withPassword.id))!)) as Awaited<ReturnType<typeof userIn>>
      const b = (await run('unlock', (await findUserById(database.db, withoutPassword.id))!)) as Awaited<ReturnType<typeof userIn>>

      expect(a).toMatchObject({ status: 'active', failedLoginAttempts: 0, lockedAt: null })
      expect(b).toMatchObject({ status: 'created', failedLoginAttempts: 0, lockedAt: null })
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

  it('deleting a user ends their sessions and says how many in the audit event', async () => {
    const user = await userIn('active')
    await addSession(user.id, 'del-1')

    await database.db.transaction((tx) => deleteUser(tx, context, user))

    expect(await sessionsOf(user.id)).toBe(0)
    expect((await event('user.delete', user.id)).details).toMatchObject({ email: user.email, sessionsEnded: 1 })
  })
})
