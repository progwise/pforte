import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Database } from '../index.js'
import { createTestDatabase, hasDatabase } from '../test/test-database.js'
import { currentCode, issueCode } from '../codes.js'
import {
  activateUser,
  confirmPhone,
  deactivateUser,
  endSessions,
  LifecycleError,
  type LifecycleAction,
  lockUser,
  requestActivationLink,
  requestPasswordReset,
  unlockUser,
} from './lifecycle.js'
import { createUser, deleteUser, findUserById, updateUser } from './users.js'

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

    it('makes the link work for as long as the caller says, also the one a person asks for themselves', async () => {
      const days = (expiresAt: Date) => (expiresAt.getTime() - Date.now()) / 86_400_000
      const user = await userIn('created')

      const invited = await database.db.transaction((tx) => activateUser(tx, context, user, { validityMs: 3 * 86_400_000 }))
      expect(days(invited.activation!.expiresAt)).toBeCloseTo(3, 2)
      expect(days((await findUserById(database.db, user.id))!.activationExpiresAt!)).toBeCloseTo(3, 2)

      const asked = await database.db.transaction((tx) => requestActivationLink(tx, context, invited.user, { validityMs: 86_400_000 }))
      expect(days(asked!.activation.expiresAt)).toBeCloseTo(1, 2)
      expect((await event('user.activation.request', user.id)).details).toMatchObject({ expiresAt: asked!.activation.expiresAt.toISOString() })
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

  describe('confirming the phone number', () => {
    const secrets = ['code-secret-code-secret-code-secret-code']
    const A = '+4915112345678'
    const B = '+4915187654321'
    const self = (userId: string) => ({ actor: { type: 'user' as const, id: userId }, ip: '203.0.113.7', userAgent: 'vitest', self: true })
    /** An active person with an unconfirmed number, and the code that was sent to it. */
    const waiting = async (phone = A) => {
      const user = await userIn('active')
      await database.pool.query(`update users set phone = $1, phone_verified_at = null where id = $2`, [phone, user.id])
      const { code } = await issueCode(database.db, { userId: user.id, channel: 'sms', purpose: 'activation', boundTo: phone }, { secrets })
      return { id: user.id, code }
    }
    const confirm = (userId: string, code: string) => confirmPhone(database.db, self(userId), { userId, code }, { secrets })
    const confirmedAt = async (userId: string) => (await findUserById(database.db, userId))!.phoneVerifiedAt

    it('confirms the number with the code that was sent to it, and records it as the person’s own doing', async () => {
      const { id, code } = await waiting()

      const confirmed = await confirm(id, `${code.slice(0, 3)} ${code.slice(3)}`)

      // What comes back is the row as this step wrote it.
      expect(confirmed).toMatchObject({ ok: true, user: { id, phone: A, phoneVerifiedAt: expect.any(Date) } })
      expect(await confirmedAt(id)).toEqual(confirmed?.ok ? confirmed.user.phoneVerifiedAt : undefined)
      expect(await event('user.phone.confirm', id)).toMatchObject({ actor_type: 'user', actor_id: id, details: { self: true } })
      // and once: there is nothing left to confirm
      await expect(confirm(id, code)).rejects.toThrow(/confirmed already/)
    })

    it('does not count what is no code at all as an attempt, and knows nobody under an unknown ID', async () => {
      const { id, code } = await waiting()

      for (const typed of ['', 'abc', '12345', '1234567']) expect(await confirm(id, typed)).toEqual({ ok: false, reason: 'malformed' })

      expect((await database.pool.query(`select attempts from otp_codes where user_id = $1`, [id])).rows[0].attempts).toBe(0)
      expect(await confirm(id, code)).toMatchObject({ ok: true })
      expect(await confirm('0190f6a8-0000-7000-8000-000000000000', code)).toBeUndefined()
    })

    it('waits for a lock of the person that is under way, and then confirms nothing: the code is not even looked at', async () => {
      const { id, code } = await waiting()
      const user = (await findUserById(database.db, id))!

      const { pending } = await database.db.transaction(async (tx) => {
        // An administrator has locked the person and not finished yet.
        await lockUser(tx, context, user)
        const pending = confirm(id, code)
        pending.catch(() => {})
        await new Promise((resolve) => setTimeout(resolve, 200))
        return { pending }
      })

      await expect(pending).rejects.toBeInstanceOf(LifecycleError)
      await expect(pending).rejects.toThrow(/user who is locked/)
      expect(await confirmedAt(id)).toBeNull()
      expect((await database.pool.query(`select attempts, consumed_at from otp_codes where user_id = $1`, [id])).rows[0]).toEqual({ attempts: 0, consumed_at: null })
      expect(await event('user.phone.confirm', id)).toBeUndefined()
    })

    it('refuses a wrong code, counts the attempt and records nothing', async () => {
      const { id, code } = await waiting()
      const wrong = code === '000000' ? '111111' : '000000'

      for (let attempt = 0; attempt < 5; attempt++) expect(await confirm(id, wrong)).toEqual({ ok: false, reason: 'wrong' })
      // The attempts were kept although nothing was confirmed: the right code is too late now.
      expect(await confirm(id, code)).toEqual({ ok: false, reason: 'exhausted' })

      expect(await confirmedAt(id)).toBeNull()
      expect(await event('user.phone.confirm', id)).toBeUndefined()
    })

    it('does not confirm another number than the one the code was sent to', async () => {
      const { id, code } = await waiting()
      // The number as a change leaves it that the code escaped: it was issued for the old number a moment after.
      await database.pool.query(`update users set phone = $1 where id = $2`, [B, id])

      expect(await confirm(id, code)).toEqual({ ok: false, reason: 'wrong' })

      expect(await confirmedAt(id)).toBeNull()
      expect(await event('user.phone.confirm', id)).toBeUndefined()
    })

    it('finds the code ended after a change of the number, and a new one confirms the new number', async () => {
      const { id, code } = await waiting()
      const user = (await findUserById(database.db, id))!
      await database.db.transaction((tx) => updateUser(tx, context, user, { phone: B }))

      expect(await currentCode(database.db, { userId: id, purpose: 'activation' })).toBeUndefined()
      expect(await confirm(id, code)).toEqual({ ok: false, reason: 'expired' })
      expect(await confirmedAt(id)).toBeNull()

      const later = new Date(Date.now() + 2 * 60 * 1000)
      const next = await issueCode(database.db, { userId: id, channel: 'sms', purpose: 'activation', boundTo: B }, { secrets, now: later })
      expect(await confirmPhone(database.db, self(id), { userId: id, code: next.code }, { secrets, now: later })).toMatchObject({ ok: true })
    })

    it('waits for a change of the number that is under way, and then refuses the code of the old one', async () => {
      const { id, code } = await waiting()
      const user = (await findUserById(database.db, id))!
      let answered = false

      const { pending } = await database.db.transaction(async (tx) => {
        // The back office has changed the number and not finished yet.
        await updateUser(tx, context, user, { phone: B })
        const pending = confirm(id, code).finally(() => (answered = true))
        await new Promise((resolve) => setTimeout(resolve, 200))
        expect(answered, 'the confirmation must wait for the change').toBe(false)
        // Wrapped, so that the change is finished here and not held until the confirmation has answered.
        return { pending }
      })

      // The change ended the code. Had it not, the code would be a wrong one for the new number.
      expect(await pending).toEqual({ ok: false, reason: 'expired' })
      const after = (await findUserById(database.db, id))!
      expect(after.phone).toBe(B)
      expect(after.phoneVerifiedAt).toBeNull()
    })

    it('is undone by a change of the number that comes right after it', async () => {
      const { id, code } = await waiting()
      const user = (await findUserById(database.db, id))!

      // The change was decided on the number as it was, while the code was being entered.
      expect(await confirm(id, code)).toMatchObject({ ok: true })
      await database.db.transaction((tx) => updateUser(tx, context, user, { phone: B }))

      const after = (await findUserById(database.db, id))!
      expect(after.phone).toBe(B)
      expect(after.phoneVerifiedAt).toBeNull()
    })

    it('does not stand in the way of a new code that is issued while it waits for the old one: neither request fails', async () => {
      const user = await userIn('active')
      await database.pool.query(`update users set phone = $1, phone_verified_at = null where id = $2`, [A, user.id])
      const start = new Date()
      const { code } = await issueCode(database.db, { userId: user.id, channel: 'sms', purpose: 'activation', boundTo: A }, { secrets, now: start })
      let confirming: Promise<unknown> = Promise.resolve()

      const reissued = await database.db.transaction(async (tx) => {
        // "Send a new code" has reached the old code and holds it ...
        await tx.execute(sql`select 1 from otp_codes where user_id = ${user.id} for update`)
        // ... when the code the person typed comes in: that holds the person's row and waits for the old code.
        confirming = confirmPhone(database.db, self(user.id), { userId: user.id, code }, { secrets, now: start })
        confirming.catch(() => {})
        await new Promise((resolve) => setTimeout(resolve, 300))
        // The new code is stored. It refers to the person's row, which must not make it wait for the confirmation.
        return issueCode(tx as unknown as Database, { userId: user.id, channel: 'sms', purpose: 'activation', boundTo: A }, { secrets, now: new Date(start.getTime() + 2 * 60 * 1000) })
      })

      expect(reissued.code).toMatch(/^\d{6}$/)
      // The code was valid when it was typed, so it counts.
      await expect(confirming).resolves.toMatchObject({ ok: true })
      expect(await confirmedAt(user.id)).toBeInstanceOf(Date)
    })

    it('has nothing to confirm for a person without a number, or with a confirmed one', async () => {
      const { id, code } = await waiting()
      await database.pool.query(`update users set phone_verified_at = now() where id = $1`, [id])
      await expect(confirm(id, code)).rejects.toThrow(/confirmed already/)
      await database.pool.query(`update users set phone = null, phone_verified_at = null where id = $1`, [id])
      await expect(confirm(id, code)).rejects.toThrow(/no phone number/)
      await database.pool.query(`update users set phone = $2, status = 'deactivated' where id = $1`, [id, A])
      await expect(confirm(id, code)).rejects.toThrow(/user who is deactivated/)
      expect((await database.pool.query(`select attempts from otp_codes where user_id = $1`, [id])).rows[0].attempts).toBe(0)
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

    it.each(['end-sessions', 'reset-password', 'lock', 'deactivate'] as const)('%s moves the count on that a sign-in under way was begun with, for that person only', async (action) => {
      const user = await userIn('active')
      const other = await userIn('active')
      const epoch = async (id: string) => (await findUserById(database.db, id))!.sessionEpoch
      expect(await epoch(user.id)).toBe(0)

      await run(action, user)
      expect(await epoch(user.id)).toBe(1)
      expect(await epoch(other.id)).toBe(0)
    })

    it('unlocking does not move the count back, and what leaves the sessions alone leaves it alone', async () => {
      const user = await userIn('active')
      await run('lock', user)
      await run('unlock', (await findUserById(database.db, user.id))!)

      expect((await findUserById(database.db, user.id))!.sessionEpoch).toBe(1)
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
    const record = (accountId: string, type: 1 | 2 | 4 | 13, payload: object, expires = `interval '1 hour'`) =>
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
    /** A refresh (4) or access (2) token: it keeps the ID of the session it was issued in, through every refresh. */
    const token = (accountId: string, type: 2 | 4, clientId: string, sid: string | undefined, expires?: string) =>
      record(accountId, type, { accountId, clientId, grantId: `grant-of-${sid}`, ...(sid ? { sid } : {}) }, expires)
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

    it('names a session that is gone at pforte but still known from the tokens of a client that asked for the session ID', async () => {
      const user = await userIn('active')
      const strict = await client({ sessionRequired: true })
      // The browser session expired or was cleaned up; the application kept refreshing.
      await grant(user.id, strict)
      await token(user.id, 4, strict, 'sid-refreshed')
      await token(user.id, 2, strict, 'sid-refreshed')
      // A second device, whose access token is all that is left.
      await token(user.id, 2, strict, 'sid-other-device')
      // And one session that is still there, with its token: named once.
      await session(user.id, { [strict]: 'sid-live' })
      await token(user.id, 4, strict, 'sid-live')

      const { logouts } = await end(user)

      expect(logouts).toEqual([
        { clientId: strict, sid: 'sid-live' },
        { clientId: strict, sid: 'sid-other-device' },
        { clientId: strict, sid: 'sid-refreshed' },
      ])
      expect((await event('user.sessions.end', user.id)).details).toMatchObject({ clientsToNotify: 1 })
    })

    it('takes no session ID from an expired token, and tells a client without the setting once whatever its tokens name', async () => {
      const user = await userIn('active')
      const strict = await client({ sessionRequired: true })
      const relaxed = await client()
      await token(user.id, 4, strict, 'sid-expired', `interval '-1 minute'`)
      await token(user.id, 4, relaxed, 'sid-a')
      await token(user.id, 4, relaxed, 'sid-b')
      await token(user.id, 2, relaxed, undefined)

      const { logouts } = await end(user)

      expect(logouts).toEqual([{ clientId: relaxed }])
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
