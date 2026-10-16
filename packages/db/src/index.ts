import { lt, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema/index.js'

export interface CreateDbOptions {
  /** Called when an idle client fails, e.g. because the database restarted. Defaults to console.error. */
  onError?: (error: Error) => void
}

export const createDb = (connectionString: string, { onError = console.error }: CreateDbOptions = {}) => {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 })
  // Without a listener, an error on an idle client crashes the process.
  pool.on('error', onError)
  const db = drizzle(pool, { schema, casing: 'snake_case' })
  return { db, pool }
}

export type Database = ReturnType<typeof createDb>['db']

/** Deletes OIDC payloads (sessions, tokens, interactions) that have expired. Returns how many. */
export const deleteExpiredOidcPayloads = async (db: Database): Promise<number> => {
  const deleted = await db
    .delete(schema.oidcPayloads)
    .where(lt(schema.oidcPayloads.expiresAt, new Date()))
    .returning({ id: schema.oidcPayloads.id })
  return deleted.length
}

export const getDatabaseTime =async (db: Database): Promise<Date> => {
  const result = await db.execute<{ now: Date }>(sql`select now() as now`)
  const row = result.rows[0]
  if (!row) throw new Error('database returned no time')
  return new Date(row.now)
}

export { schema }
