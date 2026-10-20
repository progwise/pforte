import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'

/** Names the lock that keeps two instances from migrating at once. Any fixed number will do. */
const MIGRATION_LOCK = 7_141_592_653

const appliedCount = async (pool: Pool) => {
  // Ask whether the table is there instead of failing on it: a failed query is an ERROR line in the database's log.
  const { rows: found } = await pool.query<{ present: boolean }>(`select to_regclass('drizzle.__drizzle_migrations') is not null as present`)
  if (!found[0]?.present) return 0
  const { rows } = await pool.query<{ count: string }>('select count(*) from drizzle.__drizzle_migrations')
  return Number(rows[0]?.count ?? 0)
}

/**
 * Brings the database to the current schema by applying the migrations that are missing. Safe to call from
 * several instances starting together: they take turns, and those that come later find nothing to do.
 * Returns how many migrations were applied.
 */
export const migrateDatabase = async (connectionString: string, { migrationsFolder }: { migrationsFolder: string }) => {
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 })
  // A connection that closes while it is idle, or while the pool is shutting down, must not crash the process. A query that
  // is running when its connection fails still rejects, so a real failure is not hidden.
  pool.on('error', () => {})
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
