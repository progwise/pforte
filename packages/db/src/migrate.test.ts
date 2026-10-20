import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrateDatabase } from './migrate.js'
import { createTestDatabase, hasDatabase } from './test/test-database.js'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
const migrationCount = (JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, 'utf8')) as { entries: unknown[] }).entries.length

describe.skipIf(!hasDatabase)('migrating the database', () => {
  let admin: Client
  let adminUrl: URL
  const created: string[] = []

  /** A database with nothing in it, and the address to reach it. */
  const emptyDatabase = async () => {
    const name = `pforte_migrate_${randomBytes(6).toString('hex')}`
    await admin.query(`create database ${name}`)
    created.push(name)
    const url = new URL(adminUrl)
    url.pathname = `/${name}`
    return url.toString()
  }

  beforeAll(async () => {
    adminUrl = new URL(process.env.DATABASE_URL!)
    adminUrl.pathname = '/postgres'
    admin = new Client({ connectionString: adminUrl.toString() })
    await admin.connect()
  })

  afterAll(async () => {
    for (const name of created) await admin.query(`drop database if exists ${name} with (force)`)
    await admin.end()
  })

  const tables = async (url: string) => {
    const client = new Client({ connectionString: url })
    await client.connect()
    try {
      return (await client.query(`select table_name from information_schema.tables where table_schema = 'public' order by 1`)).rows.map((row) => row.table_name as string)
    } finally {
      await client.end()
    }
  }

  it('creates the schema in an empty database and says how many migrations it applied', async () => {
    const url = await emptyDatabase()

    const result = await migrateDatabase(url, { migrationsFolder })

    expect(result.applied).toBe(migrationCount)
    expect(await tables(url)).toEqual(expect.arrayContaining(['users', 'clients', 'audit_events', 'oidc_payloads']))
  })

  it('finds nothing to do the second time', async () => {
    const url = await emptyDatabase()
    await migrateDatabase(url, { migrationsFolder })

    expect((await migrateDatabase(url, { migrationsFolder })).applied).toBe(0)
  })

  it('leaves a database alone that was migrated the way developers do', async () => {
    const database = await createTestDatabase()
    try {
      const url = (database.pool as unknown as { options: { connectionString: string } }).options.connectionString

      expect((await migrateDatabase(url, { migrationsFolder })).applied).toBe(0)
    } finally {
      await database.drop()
    }
  })

  it('lets several instances start together: they take turns and nothing breaks', async () => {
    const url = await emptyDatabase()

    const results = await Promise.all(Array.from({ length: 4 }, () => migrateDatabase(url, { migrationsFolder })))

    expect(results.reduce((sum, result) => sum + result.applied, 0)).toBe(migrationCount)
    expect(await tables(url)).toContain('users')
  })

  it('says why when the database cannot be reached', async () => {
    await expect(migrateDatabase('postgres://nobody:nothing@127.0.0.1:1/none', { migrationsFolder })).rejects.toThrow()
  })

  it('does not leave its lock behind: the next run is not blocked', async () => {
    const url = await emptyDatabase()
    await migrateDatabase(url, { migrationsFolder })

    await expect(Promise.race([migrateDatabase(url, { migrationsFolder }), new Promise((_, reject) => setTimeout(() => reject(new Error('blocked')), 5000))])).resolves.toMatchObject({ applied: 0 })
  })
})
