import { endSessions, findUserById } from '@progwise/pforte-db/admin'
import { sql } from 'drizzle-orm'
import type { AdminHarness } from './admin-harness.js'

/** Waits until a statement of this database waits for a lock: a request has then got as far as it can. */
export const untilWaitingForLock = async (h: AdminHarness, otherwise: string) => {
  for (let attempt = 0; ; attempt++) {
    const { rows } = await h.database.pool.query(`select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`)
    if (Number(rows[0].count) > 0) return
    if (attempt > 200) throw new Error(otherwise)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * Ends a person's sessions at the worst moment for a request that is under way: after the request has passed
 * every check it makes on arrival, and before it stores anything.
 *
 * `start` begins the request (do not await it). The person's row is locked first, so the request stops where it
 * wants that lock to store something for them. Once it waits there, the sessions are ended in the transaction
 * that holds the lock, and only then may the request go on. Returns what the request answered.
 *
 * `whileWaiting` looks at what the request has done by the time it waits, before the sessions are ended.
 */
export const endSessionsDuring = async <Response>(h: AdminHarness, userId: string, start: () => Promise<Response>, whileWaiting: () => Promise<void> = async () => {}) => {
  const user = (await findUserById(h.database.db, userId))!
  let locked!: () => void
  const holding = new Promise<void>((resolve) => (locked = resolve))
  let go!: () => void
  const waited = new Promise<void>((resolve) => (go = resolve))

  const ending = h.database.db.transaction(async (tx) => {
    await tx.execute(sql`select id from users where id = ${userId} for update`)
    locked()
    await waited
    await endSessions(tx, { actor: { type: 'client', id: 'tester' } }, user)
  })
  await holding

  const request = start()
  await untilWaitingForLock(h, 'the request never waited for the lock on the person: it stores nothing under that lock')
  try {
    await whileWaiting()
  } finally {
    go()
    await ending
  }
  return request
}
