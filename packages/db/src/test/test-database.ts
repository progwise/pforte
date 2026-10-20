import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Client } from 'pg'
import { createDb } from '../index.js'

// Tests run from packages/db; the shared .env lives in the repository root.
try {
  process.loadEnvFile(resolve(process.cwd(), '../../.env'))
} catch {
  // No .env file: DATABASE_URL must come from the environment.
}

/** True when the tests can reach a Postgres server. In CI a missing URL is an error, not a skip. */
export const hasDatabase = Boolean(process.env.DATABASE_URL) || Boolean(process.env.CI)

/**
 * Creates a throwaway database on the server from DATABASE_URL and applies all migrations,
 * so tests never touch development data. Call `drop()` when done.
 */
export const createTestDatabase = async () => {
  const baseUrl = process.env.DATABASE_URL
  if (!baseUrl) {
    throw new Error('DATABASE_URL is required for database tests (run pnpm dev:up and copy .env.example)')
  }

  const name = `pforte_test_${randomBytes(6).toString('hex')}`
  const adminUrl = new URL(baseUrl)
  adminUrl.pathname = '/postgres'
  const admin = new Client({ connectionString: adminUrl.toString() })
  await admin.connect()
  await admin.query(`create database ${name}`)

  const testUrl = new URL(baseUrl)
  testUrl.pathname = `/${name}`
  // Dropping the database at the end closes connections that may still be shutting down; that is not worth a log line.
  const { db, pool } = createDb(testUrl.toString(), { onError: () => {} })
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) })

  return {
    db,
    pool,
    drop: async () => {
      await pool.end()
      await admin.query(`drop database ${name} with (force)`)
      await admin.end()
    },
  }
}

/** Runs a query that must fail and returns the Postgres error (code, constraint, …). */
export const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as { code?: string; constraint?: string }
  }
  throw new Error('expected the query to be rejected')
}
