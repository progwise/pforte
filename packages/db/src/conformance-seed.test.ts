import { verify } from '@node-rs/argon2'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CONFORMANCE_USER_EMAIL, seedConformance } from './conformance-seed.js'
import { createTestDatabase, hasDatabase } from './test/test-database.js'

describe.skipIf(!hasDatabase)('conformance seed', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  afterAll(async () => {
    await database?.drop()
  })

  it('registers two confidential clients for the suite callback, with secrets that verify', async () => {
    const credentials = await seedConformance(database.db, { alias: 'progwise-pforte' })

    const { rows } = await database.pool.query(`select * from clients order by client_id`)
    expect(rows.map((row) => row.client_id)).toEqual(['conformance-1', 'conformance-2'])
    for (const row of rows) {
      expect(row.type).toBe('confidential')
      expect(row.redirect_uris).toEqual([
        'https://www.certification.openid.net/test/a/progwise-pforte/callback',
        'https://www.certification.openid.net/test/a/progwise-pforte/callback?dummy1=lorem&dummy2=ipsum',
      ])
      const secret = credentials.clients.find((client) => client.clientId === row.client_id)!.secret
      expect(await verify(row.secret_hash, secret)).toBe(true)
    }
  })

  it('creates an active test user whose password verifies', async () => {
    const credentials = await seedConformance(database.db, { alias: 'progwise-pforte' })

    const { rows } = await database.pool.query(`select * from users where email = $1`, [CONFORMANCE_USER_EMAIL])
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('active')
    expect(await verify(rows[0].password_hash, credentials.user.password)).toBe(true)
  })

  it('issues fresh secrets on every run and leaves no duplicates', async () => {
    const first = await seedConformance(database.db, { alias: 'progwise-pforte' })
    const second = await seedConformance(database.db, { alias: 'progwise-pforte' })

    expect(second.clients[0]!.secret).not.toBe(first.clients[0]!.secret)
    expect(second.user.password).not.toBe(first.user.password)
    const { rows } = await database.pool.query(`select (select count(*) from clients) as clients, (select count(*) from users) as users`)
    expect(rows[0]).toEqual({ clients: '2', users: '1' })
    const stored = await database.pool.query(`select secret_hash from clients where client_id = 'conformance-1'`)
    expect(await verify(stored.rows[0].secret_hash, first.clients[0]!.secret)).toBe(false)
  })

  it.each(['A', 'ab', 'has space', '-leading', 'under_score'])('rejects the alias "%s"', async (alias) => {
    await expect(seedConformance(database.db, { alias })).rejects.toThrow(/Invalid alias/)
  })

  it('refuses to run in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    try {
      await expect(seedConformance(database.db, { alias: 'progwise-pforte' })).rejects.toThrow(/Refusing/)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
