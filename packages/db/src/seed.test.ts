import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { seed } from './seed.js'
import { createTestDatabase, hasDatabase } from './test/test-database.js'

describe.skipIf(!hasDatabase)('seed', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  afterAll(async () => {
    await database?.drop()
  })

  const count = async (table: string, where = 'true') => {
    const { rows } = await database.pool.query<{ count: string }>(`select count(*) from ${table} where ${where}`)
    return Number(rows[0]!.count)
  }

  it('creates one admin, four clients and ten users with claims', async () => {
    await seed(database.db)

    expect(await count('users', 'is_admin')).toBe(1)
    expect(await count('users', 'not is_admin')).toBe(10)
    expect(await count('clients')).toBe(4)
    expect(await count('clients', `'admin' = any(scopes)`)).toBe(1)
    expect(await count('user_claims', `claim_type_key = 'partner_no'`)).toBeGreaterThanOrEqual(10)
  })

  it('changes nothing when run again', async () => {
    const before = [await count('users'), await count('user_claims'), await count('clients')]
    const { newUsers } = await seed(database.db)
    const after = [await count('users'), await count('user_claims'), await count('clients')]

    expect(newUsers).toBe(0)
    expect(after).toEqual(before)
  })

  it('stores argon2id password hashes', async () => {
    const { rows } = await database.pool.query<{ password_hash: string }>(
      `select password_hash from users where email = 'admin@example.com'`,
    )
    expect(rows[0]!.password_hash).toMatch(/^\$argon2id\$/)
  })

  it('refuses to run in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    try {
      await expect(seed(database.db)).rejects.toThrow(/Refusing to seed/)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
