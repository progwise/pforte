import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, hasDatabase } from '../test/test-database.js'
import { createUser, deleteUser, findUserByEmail, listUsers, profileChanges, updateUser } from './users.js'

const context = { actor: { type: 'client' as const, id: 'tester' }, ip: '203.0.113.7', userAgent: 'vitest' }

describe.skipIf(!hasDatabase)('admin user queries', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  afterAll(async () => {
    await database?.drop()
  })

  const count = async (table: string, where = 'true') =>
    Number((await database.pool.query(`select count(*) from ${table} where ${where}`)).rows[0].count)

  it('records the change and its audit event together', async () => {
    const user = await database.db.transaction((tx) =>
      createUser(tx, context, { email: 'a@example.com', firstName: 'A', lastName: 'One' }),
    )

    const { rows } = await database.pool.query(`select * from audit_events where target_id = $1`, [user.id])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor_type: 'client',
      actor_id: 'tester',
      action: 'user.create',
      target_type: 'user',
      ip: '203.0.113.7',
      user_agent: 'vitest',
    })
    expect(rows[0].details).toMatchObject({ email: 'a@example.com' })
  })

  it('applies neither the change nor the audit event when the transaction fails', async () => {
    const users = await count('users')
    const events = await count('audit_events')

    await expect(
      database.db.transaction(async (tx) => {
        await createUser(tx, context, { email: 'rolled-back@example.com', firstName: 'R', lastName: 'B' })
        throw new Error('something went wrong afterwards')
      }),
    ).rejects.toThrow('something went wrong afterwards')

    expect(await count('users')).toBe(users)
    expect(await count('audit_events')).toBe(events)
  })

  it('applies neither when the audit event itself cannot be written', async () => {
    const users = await count('users')

    await expect(
      database.db.transaction((tx) =>
        // An unknown actor type is refused by the enum, after the user row was inserted.
        createUser(tx, { ...context, actor: { type: 'robot' as never } }, { email: 'half@example.com', firstName: 'H', lastName: 'F' }),
      ),
    ).rejects.toThrow()

    expect(await count('users')).toBe(users)
    expect(await findUserByEmail(database.db, 'half@example.com')).toBeUndefined()
  })

  it('reports exactly what differs between a user and a wanted profile', async () => {
    const user = (await findUserByEmail(database.db, 'a@example.com'))!

    expect(profileChanges(user, { firstName: 'A', lastName: 'One' })).toEqual({})
    expect(profileChanges(user, { firstName: 'Anna', phone: '+4915100000000' })).toEqual({
      firstName: { from: 'A', to: 'Anna' },
      phone: { from: null, to: '+4915100000000' },
    })
  })

  it('writes nothing and records nothing when an update changes nothing', async () => {
    const user = (await findUserByEmail(database.db, 'a@example.com'))!
    const events = await count('audit_events')

    const result = await database.db.transaction((tx) => updateUser(tx, context, user, { firstName: user.firstName }))

    expect(result.changed).toBe(false)
    expect(await count('audit_events')).toBe(events)
  })

  it('forgets the confirmation of a phone number or address when it changes, and keeps it otherwise', async () => {
    const created = await database.db.transaction((tx) =>
      createUser(tx, context, { email: 'confirmed@example.com', firstName: 'Con', lastName: 'Firmed', phone: '+4915112345678' }),
    )
    await database.pool.query(`update users set phone_verified_at = now(), email_verified_at = now() where id = $1`, [created.id])
    const confirmed = (await findUserByEmail(database.db, 'confirmed@example.com'))!

    const renamed = await database.db.transaction((tx) => updateUser(tx, context, confirmed, { firstName: 'Conny' }))
    expect(renamed.user.phoneVerifiedAt).not.toBeNull()
    expect(renamed.user.emailVerifiedAt).not.toBeNull()

    const newNumber = await database.db.transaction((tx) => updateUser(tx, context, renamed.user, { phone: '+4915198765432' }))
    expect(newNumber.user.phoneVerifiedAt).toBeNull()
    expect(newNumber.user.emailVerifiedAt).not.toBeNull()

    const newAddress = await database.db.transaction((tx) => updateUser(tx, context, newNumber.user, { email: 'moved@example.com' }))
    expect(newAddress.user.emailVerifiedAt).toBeNull()
  })

  it('keeps who a deleted user was in the audit log', async () => {
    const user = await database.db.transaction((tx) =>
      createUser(tx, context, { email: 'gone@example.com', firstName: 'Gone', lastName: 'Soon' }),
    )

    await database.db.transaction((tx) => deleteUser(tx, context, user))

    expect(await findUserByEmail(database.db, 'gone@example.com')).toBeUndefined()
    const { rows } = await database.pool.query(
      `select details from audit_events where target_id = $1 and action = 'user.delete'`,
      [user.id],
    )
    expect(rows[0].details).toMatchObject({ email: 'gone@example.com', firstName: 'Gone', lastName: 'Soon' })
  })

  it('pages through all users in order without repeating any', async () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      await database.db.transaction((tx) =>
        createUser(tx, context, { email: `page${n}@example.com`, firstName: 'Page', lastName: `N${n}` }),
      )
    }
    const everyone = await count('users')

    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await listUsers(database.db, { limit: 3, after: cursor })
      seen.push(...page.items.map((user) => user.id))
      cursor = page.nextCursor
    } while (cursor)

    expect(seen).toHaveLength(everyone)
    expect(new Set(seen).size).toBe(everyone)
    expect(seen).toEqual([...seen].sort())
  })

  it('searches literally, so % and _ are not wildcards', async () => {
    expect((await listUsers(database.db, { search: '%', limit: 50 })).items).toHaveLength(0)
    expect((await listUsers(database.db, { search: 'page3@', limit: 50 })).items).toHaveLength(1)
    expect((await listUsers(database.db, { search: 'PAGE', limit: 50 })).items.length).toBeGreaterThanOrEqual(7)
  })
})
