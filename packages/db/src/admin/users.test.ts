import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { currentCode, issueCode } from '../codes.js'
import type { Database } from '../index.js'
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

  describe('a code that is out to confirm the phone number', () => {
    const secrets = ['code-secret-code-secret-code-secret-code']
    const NUMBER = '+4915112345678'
    const activation = (userId: string) => ({ userId, purpose: 'activation' as const })
    const withCode = async (email: string) => {
      const user = await database.db.transaction((tx) => createUser(tx, context, { email, firstName: 'Co', lastName: 'De', phone: NUMBER }))
      await issueCode(database.db, { ...activation(user.id), channel: 'sms', boundTo: NUMBER }, { secrets })
      return user
    }

    it('is ended when the number changes or is taken away, and stays for any other change', async () => {
      const user = await withCode('code-out@example.com')

      const renamed = await database.db.transaction((tx) => updateUser(tx, context, user, { firstName: 'Cody', email: 'code-still-out@example.com' }))
      expect(await currentCode(database.db, activation(user.id))).toMatchObject({ usable: true })

      const changed = await database.db.transaction((tx) => updateUser(tx, context, renamed.user, { phone: '+4915198765432' }))
      expect(await currentCode(database.db, activation(user.id))).toBeUndefined()
      // It was not used, so it still counts towards the limits on asking for codes.
      expect(await count('otp_codes', `user_id = '${user.id}' and consumed_at is null`)).toBe(1)

      await database.pool.query(`update otp_codes set created_at = created_at - interval '2 minutes' where user_id = $1`, [user.id])
      await issueCode(database.db, { ...activation(user.id), channel: 'sms', boundTo: '+4915198765432' }, { secrets })
      await database.db.transaction((tx) => updateUser(tx, context, changed.user, { phone: null }))
      expect(await currentCode(database.db, activation(user.id))).toBeUndefined()
    })

    it('does not make the change wait for a request for a new code that holds it: neither request fails', async () => {
      const user = await withCode('code-held@example.com')
      await database.pool.query(`update otp_codes set created_at = created_at - interval '2 minutes' where user_id = $1`, [user.id])

      const reissued = await database.db.transaction(async (tx) => {
        // "Send a new code" has reached the old code and holds it ...
        await tx.execute(sql`select 1 from otp_codes where user_id = ${user.id} for update`)
        // ... when the back office changes number and address. A new address holds the person's row so that the
        // new code, which refers to it, has to wait: the change must be through before, not wait for the code.
        const changed = await Promise.race([
          database.db.transaction((other) => updateUser(other, context, user, { phone: '+4915198765432', email: 'code-moved@example.com' })),
          new Promise<'waits'>((resolve) => setTimeout(() => resolve('waits'), 2000)),
        ])
        expect(changed).toMatchObject({ changed: true })
        return issueCode(tx as unknown as Database, { ...activation(user.id), channel: 'sms', boundTo: NUMBER }, { secrets })
      })

      expect(reissued.code).toMatch(/^\d{6}$/)
      expect((await findUserByEmail(database.db, 'code-moved@example.com'))!.phoneVerifiedAt).toBeNull()
    })
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
