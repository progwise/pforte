import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema/index.js'

export const createDb = (connectionString: string) => {
  const pool = new Pool({ connectionString })
  const db = drizzle(pool, { schema })
  return { db, pool }
}

export type Database = ReturnType<typeof createDb>['db']

export const getDatabaseTime = async (db: Database): Promise<Date> => {
  const result = await db.execute<{ now: Date }>(sql`select now() as now`)
  const row = result.rows[0]
  if (!row) throw new Error('database returned no time')
  return new Date(row.now)
}

export { schema }
