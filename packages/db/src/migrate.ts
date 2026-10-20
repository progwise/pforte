import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'

/** Names the lock that keeps two instances from migrating at once. Any fixed number will do. */
const MIGRATION_LOCK = 7_141_592_653

const appliedCount = async (pool: Pool) => {
  try {
    const { rows } = await pool.query<{ count: string }>('select count(*) from drizzle.__drizzle_migrations')
    return Number(rows[0]?.count ?? 0)
  } catch {
    return 0 // the table does not exist yet: nothing was applied
  }
}

/**
 * Brings the database to the current schema by applying the migrations that are missing. Safe to call from
 * several instances starting together: they take turns, and those that come later find nothing to do.
 * Returns how many migrations were applied.
 */
export const migrateDatabase = async (connectionString: string, { migrationsFolder }: { migrationsFolder: string }) => {
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 })
  const lock = await pool.connect().catch(async (error: Error) => {
    await pool.end()
    throw error
  })
  try {
    await lock.query('select pg_advisory_lock($1)', [MIGRATION_LOCK])
    const before = await appliedCount(pool)
    await migrate(drizzle(pool), { migrationsFolder })
    return { applied: (await appliedCount(pool)) - before }
  } finally {
    await lock.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {})
    lock.release()
    await pool.end()
  }
}
