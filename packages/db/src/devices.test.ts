import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listDevices, revokeAllDevices, revokeDevice } from './admin/devices.js'
import { lockUser } from './admin/lifecycle.js'
import { createUser, findUserById } from './admin/users.js'
import { DEVICE_LIFETIME_MS, deleteOldDevices, findRememberedDevice, rememberDevice } from './devices.js'
import { createTestDatabase, hasDatabase } from './test/test-database.js'

const context = { actor: { type: 'client' as const, id: 'tester' }, ip: '203.0.113.7', userAgent: 'vitest' }
const day = 24 * 60 * 60 * 1000

describe.skipIf(!hasDatabase)('remembered devices', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>
  let counter = 0
  const start = new Date('2030-01-01T10:00:00Z')

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  afterAll(async () => {
    await database?.drop()
  })

  const newUser = async () => {
    const created = await database.db.transaction((tx) =>
      createUser(tx, context, { email: `device${++counter}@example.com`, firstName: 'D', lastName: `${counter}` }),
    )
    await database.pool.query(`update users set status = 'active', password_hash = 'hash' where id = $1`, [created.id])
    return (await findUserById(database.db, created.id))!
  }

  it('recognises a remembered device for 90 days, and stores only a hash', async () => {
    const user = await newUser()
    const { token, expiresAt } = await rememberDevice(database.db, { userId: user.id, userAgent: 'Firefox' }, start)
    expect(expiresAt.getTime() - start.getTime()).toBe(DEVICE_LIFETIME_MS)

    const { rows } = await database.pool.query(`select token_hash from devices where user_id = $1`, [user.id])
    expect(rows[0].token_hash).not.toContain(token)

    expect(await findRememberedDevice(database.db, user.id, [token], new Date(start.getTime() + 89 * day))).toBeDefined()
    expect(await findRememberedDevice(database.db, user.id, [token], new Date(start.getTime() + 91 * day))).toBeUndefined()
  })

  it('belongs to one user only', async () => {
    const owner = await newUser()
    const other = await newUser()
    const { token } = await rememberDevice(database.db, { userId: owner.id }, start)
    expect(await findRememberedDevice(database.db, other.id, [token], start)).toBeUndefined()
  })

  it('finds the right token among several, ignores unknown ones, and says no for none', async () => {
    const user = await newUser()
    const { token } = await rememberDevice(database.db, { userId: user.id }, start)
    expect(await findRememberedDevice(database.db, user.id, ['nonsense', token], start)).toBeDefined()
    expect(await findRememberedDevice(database.db, user.id, ['nonsense'], start)).toBeUndefined()
    expect(await findRememberedDevice(database.db, user.id, [], start)).toBeUndefined()
  })

  it('notes when the device was last seen', async () => {
    const user = await newUser()
    const { token } = await rememberDevice(database.db, { userId: user.id }, start)
    const later = new Date(start.getTime() + 3 * day)
    await findRememberedDevice(database.db, user.id, [token], later)
    expect((await listDevices(database.db, user.id, later))[0]!.lastSeenAt).toEqual(later)
  })

  it('lists active devices and revokes one, with an audit event', async () => {
    const user = await newUser()
    const first = await rememberDevice(database.db, { userId: user.id, userAgent: 'Firefox' }, start)
    await rememberDevice(database.db, { userId: user.id, userAgent: 'Safari' }, start)
    const listed = await listDevices(database.db, user.id, start)
    expect(listed.map((device) => device.userAgent).sort()).toEqual(['Firefox', 'Safari'])

    const firefox = listed.find((device) => device.userAgent === 'Firefox')!
    expect(await database.db.transaction((tx) => revokeDevice(tx, context, user, firefox.id))).toBe(true)
    expect(await database.db.transaction((tx) => revokeDevice(tx, context, user, firefox.id))).toBe(false)
    expect(await findRememberedDevice(database.db, user.id, [first.token], start)).toBeUndefined()
    expect(await listDevices(database.db, user.id, start)).toHaveLength(1)

    const { rows } = await database.pool.query(`select * from audit_events where action = 'user.device.revoke' and target_id = $1`, [user.id])
    expect(rows).toHaveLength(1)
    expect(rows[0].details.userAgent).toBe('Firefox')
  })

  it("cannot revoke another user's device", async () => {
    const owner = await newUser()
    const other = await newUser()
    await rememberDevice(database.db, { userId: owner.id }, start)
    const [device] = await listDevices(database.db, owner.id, start)
    expect(await database.db.transaction((tx) => revokeDevice(tx, context, other, device!.id))).toBe(false)
  })

  it('revokes all devices at once', async () => {
    const user = await newUser()
    const { token } = await rememberDevice(database.db, { userId: user.id }, start)
    await rememberDevice(database.db, { userId: user.id }, start)
    expect(await database.db.transaction((tx) => revokeAllDevices(tx, context, user))).toBe(2)
    expect(await findRememberedDevice(database.db, user.id, [token], new Date())).toBeUndefined()
    expect(await database.db.transaction((tx) => revokeAllDevices(tx, context, user))).toBe(0)
  })

  it('is revoked when the user is locked', async () => {
    const user = await newUser()
    const { token } = await rememberDevice(database.db, { userId: user.id })
    await database.db.transaction((tx) => lockUser(tx, context, user))
    expect(await findRememberedDevice(database.db, user.id, [token])).toBeUndefined()
    const { rows } = await database.pool.query(`select details from audit_events where action = 'user.lock' and target_id = $1`, [user.id])
    expect(rows[0].details.devicesRevoked).toBe(1)
  })

  it('deletes devices that expired or were revoked a month ago', async () => {
    const user = await newUser()
    await rememberDevice(database.db, { userId: user.id }, new Date(start.getTime() - 200 * day))
    await rememberDevice(database.db, { userId: user.id }, start)
    await deleteOldDevices(database.db, start)
    const { rows } = await database.pool.query(`select expires_at from devices where user_id = $1`, [user.id])
    expect(rows).toHaveLength(1)
    expect(rows[0].expires_at.getTime()).toBeGreaterThan(start.getTime())
  })
})
