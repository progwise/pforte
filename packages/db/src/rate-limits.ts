import { inArray, like, sql } from 'drizzle-orm'
import type { Database } from './index.js'
import { rateLimits } from './schema/index.js'

/** What is counted (`key`), how many are allowed (`max`) and in which window. */
export interface Rule {
  key: string
  max: number
  windowSeconds: number
}

const endOfWindow = (windowStart: Date, windowSeconds: number) => windowStart.getTime() + windowSeconds * 1000

/**
 * Counts one event for each rule. A counter starts a new window when its old one has run out; within
 * a window it only grows. One statement per rule, so parallel requests are counted exactly.
 */
export const count = async (db: Database, rules: Rule[], now = new Date()) => {
  for (const { key, windowSeconds } of rules) {
    await db.execute(sql`
      insert into rate_limits (key, window_start, hits)
      values (${key}, ${now.toISOString()}::timestamptz, 1)
      on conflict (key) do update set
        hits = case when rate_limits.window_start <= ${now.toISOString()}::timestamptz - make_interval(secs => ${windowSeconds})
                    then 1 else rate_limits.hits + 1 end,
        window_start = case when rate_limits.window_start <= ${now.toISOString()}::timestamptz - make_interval(secs => ${windowSeconds})
                            then ${now.toISOString()}::timestamptz else rate_limits.window_start end`)
  }
}

/**
 * For how many seconds the rules say "not now": 0 if all of them allow it. A rule blocks when its counter
 * has reached `max` in the current window; the answer is the longest of the waits, so one `Retry-After`
 * is true for all of them. Does not count anything.
 */
export const blockedFor = async (db: Database, rules: Rule[], now = new Date()) => {
  if (rules.length === 0) return 0
  const rows = await db.select().from(rateLimits).where(inArray(rateLimits.key, rules.map((rule) => rule.key)))
  let wait = 0
  for (const rule of rules) {
    const row = rows.find((candidate) => candidate.key === rule.key)
    if (!row || row.hits < rule.max) continue
    const seconds = Math.ceil((endOfWindow(row.windowStart, rule.windowSeconds) - now.getTime()) / 1000)
    wait = Math.max(wait, seconds)
  }
  return Math.max(wait, 0)
}

/** Counts one event, and says how long to wait if that made it too many: the rule allows `max` events per window. */
export const consume = async (db: Database, rule: Rule, now = new Date()) => {
  await count(db, [rule], now)
  return blockedFor(db, [{ ...rule, max: rule.max + 1 }], now)
}

/** Forgets the counters with these keys, e.g. after an administrator unlocked someone. */
export const clear = async (db: Database, keys: string[]) => {
  if (keys.length > 0) await db.delete(rateLimits).where(inArray(rateLimits.key, keys))
}

/** Forgets every counter whose key starts with the prefix. */
export const clearPrefix = async (db: Database, prefix: string) => {
  await db.delete(rateLimits).where(like(rateLimits.key, `${prefix.replace(/[\\%_]/g, '\\$&')}%`))
}

/** Deletes counters whose window ended long ago. Returns how many. */
export const deleteOldRateLimits = async (db: Database, now = new Date()) => {
  const result = await db.execute(sql`delete from rate_limits where window_start < ${new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()}::timestamptz`)
  return result.rowCount ?? 0
}
