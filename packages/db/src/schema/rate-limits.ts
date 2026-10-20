import { integer, pgTable, text } from 'drizzle-orm/pg-core'
import { timestamptz } from './columns.js'

/**
 * Counters behind the rate limits: how often something happened in the current window. A key names what
 * is counted and for whom, e.g. `pw:ip:203.0.113.7`. Keys never contain an e-mail address, only a keyed hash.
 */
export const rateLimits = pgTable('rate_limits', {
  key: text().primaryKey(),
  windowStart: timestamptz().notNull(),
  hits: integer().notNull(),
})
