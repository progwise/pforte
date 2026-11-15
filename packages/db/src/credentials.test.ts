import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { activateUser } from './admin/lifecycle.js'
import { createUser, findUserById } from './admin/users.js'
import { completeActivation, completePasswordReset, findPendingActivation } from './credentials.js'
import { findRememberedDevice, rememberDevice } from './devices.js'
import { createTestDatabase, hasDatabase } from './test/test-database.js'

const context = { actor: { type: 'client' as const, id: 'tester' }, ip: '203.0.113.7', userAgent: 'vitest' }
const day = 24 * 60 * 60 * 1000

describe.skipIf(!hasDatabase)('activation and password reset', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>
  let counter = 0

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  afterAll(async () => {
    await database?.drop()
  })

  const newUser = async () =>
    database.db.transaction((tx) => createUser(tx, context, { email: `cred${++counter}@example.com`, firstName: 'C', lastName: `${counter}` }))

  /** A created user with an activation link; returns the token that would be e-mailed. */
  const withLink = async () => {
    const user = await newUser()
    const { activation } = await database.db.transaction((tx) => activateUser(tx, context, user))
    return { user, token: activation!.token, expiresAt: activation!.expiresAt }
  }

  it('finds a user by a valid link only', async () => {
    const { user, token, expiresAt } = await withLink()
    expect((await findPendingActivation(database.db, token))?.id).toBe(user.id)
    expect(await findPendingActivation(database.db, 'not-a-token')).toBeUndefined()
    expect(await findPendingActivation(database.db, token, new Date(expiresAt.getTime() + 1000))).toBeUndefined()
  })

  it('activates with the first password, verifies the e-mail and records who did it', async () => {
    const { user, token } = await withLink()
    const done = await completeActivation(database.db, { token, passwordHash: 'hash-1', ip: '198.51.100.9', userAgent: 'Firefox' })

    expect(done!.user).toMatchObject({ id: user.id, status: 'active', passwordHash: 'hash-1', activationTokenHash: null })
    expect(done!.user.emailVerifiedAt).not.toBeNull()
    const { rows } = await database.pool.query(`select * from audit_events where action = 'user.activate.complete' and target_id = $1`, [user.id])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor_type: 'user', actor_id: user.id, ip: '198.51.100.9' })
    expect(JSON.stringify(rows[0].details)).not.toContain('hash-1')
  })

  it('remembers the device only when asked to, and says so in the audit event', async () => {
    const plain = await withLink()
    const without = await completeActivation(database.db, { token: plain.token, passwordHash: 'h' })
    expect(without!.deviceToken).toBeUndefined()
    expect(await findRememberedDevice(database.db, plain.user.id, ['anything'])).toBeUndefined()
    const { rows: quiet } = await database.pool.query(`select details from audit_events where action = 'user.activate.complete' and target_id = $1`, [plain.user.id])
    expect(quiet[0].details).not.toHaveProperty('deviceRemembered')

    const { user, token } = await withLink()
    const done = await completeActivation(database.db, { token, passwordHash: 'h', remember: true, userAgent: 'Firefox' })
    expect(done!.deviceToken).toBeTruthy()
    expect(await findRememberedDevice(database.db, user.id, [done!.deviceToken!])).toBeDefined()
    const { rows: devices } = await database.pool.query(`select user_agent, token_hash from devices where user_id = $1`, [user.id])
    expect(devices).toHaveLength(1)
    expect(devices[0].user_agent).toBe('Firefox')
    expect(devices[0].token_hash).not.toBe(done!.deviceToken)
    const { rows } = await database.pool.query(`select details from audit_events where action = 'user.activate.complete' and target_id = $1`, [user.id])
    expect(rows[0].details).toMatchObject({ deviceRemembered: true })
    expect(JSON.stringify(rows[0].details)).not.toContain(done!.deviceToken)
  })

  it('remembers no device when the link is not valid', async () => {
    const { user, token, expiresAt } = await withLink()
    expect(await completeActivation(database.db, { token, passwordHash: 'h', remember: true }, new Date(expiresAt.getTime() + day))).toBeUndefined()
    expect((await database.pool.query(`select count(*) from devices where user_id = $1`, [user.id])).rows[0].count).toBe('0')
  })

  it('works once, even when two requests race', async () => {
    const { token } = await withLink()
    const results = await Promise.all([1, 2, 3].map((n) => completeActivation(database.db, { token, passwordHash: `hash-${n}` })))
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await completeActivation(database.db, { token, passwordHash: 'again' })).toBeUndefined()
  })

  it('refuses an expired link and a link of a deactivated user', async () => {
    const { token, expiresAt } = await withLink()
    expect(await completeActivation(database.db, { token, passwordHash: 'h' }, new Date(expiresAt.getTime() + day))).toBeUndefined()

    const other = await withLink()
    await database.pool.query(`update users set status = 'deactivated' where id = $1`, [other.user.id])
    expect(await completeActivation(database.db, { token: other.token, passwordHash: 'h' })).toBeUndefined()
  })

  it('replaces the password, ends sessions and devices, and records the reset', async () => {
    const { token, user } = await withLink()
    await completeActivation(database.db, { token, passwordHash: 'old-hash' })
    await rememberDevice(database.db, { userId: user.id })
    await database.pool.query(
      `insert into oidc_payloads (id, type, payload, account_id, expires_at) values ('s1', 1, '{}', $1, now() + interval '1 day')`,
      [user.id],
    )

    expect(await completePasswordReset(database.db, { userId: user.id, passwordHash: 'new-hash', ip: '198.51.100.9' })).toBe(true)

    expect((await findUserById(database.db, user.id))!.passwordHash).toBe('new-hash')
    expect((await database.pool.query(`select count(*) from oidc_payloads where account_id = $1`, [user.id])).rows[0].count).toBe('0')
    expect((await database.pool.query(`select count(*) from devices where user_id = $1 and revoked_at is null`, [user.id])).rows[0].count).toBe('0')
    const { rows } = await database.pool.query(`select details from audit_events where action = 'user.password_reset.complete' and target_id = $1`, [user.id])
    expect(rows[0].details).toMatchObject({ sessionsEnded: 1, devicesRevoked: 1 })
  })

  it('does not reset the password of a user who cannot sign in', async () => {
    const { token, user } = await withLink()
    await completeActivation(database.db, { token, passwordHash: 'old-hash' })
    await database.pool.query(`update users set status = 'locked' where id = $1`, [user.id])
    expect(await completePasswordReset(database.db, { userId: user.id, passwordHash: 'new-hash' })).toBe(false)
    expect((await findUserById(database.db, user.id))!.passwordHash).toBe('old-hash')
  })
})
