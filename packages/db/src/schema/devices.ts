import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { id, timestamps, timestamptz } from './columns.js'
import { users } from './users.js'

/** Remembered devices that skip the second factor. */
export const devices = pgTable(
  'devices',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text().notNull().unique('devices_token_hash_unique'),
    userAgent: text(),
    lastSeenAt: timestamptz().notNull().defaultNow(),
    expiresAt: timestamptz().notNull(),
    revokedAt: timestamptz(),
    ...timestamps(),
  },
  (table) => [index('devices_user_id').on(table.userId)],
)
