import { index, integer, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { id, timestamps, timestamptz } from './columns.js'
import { users } from './users.js'

export const otpChannel = pgEnum('otp_channel', ['sms', 'email'])
export const otpPurpose = pgEnum('otp_purpose', ['login', 'password_reset', 'activation'])

/** Pending one-time codes. */
export const otpCodes = pgTable(
  'otp_codes',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: otpChannel().notNull(),
    purpose: otpPurpose().notNull(),
    /** HMAC of the code with a server secret. A plain hash of 6 digits is trivial to brute-force. */
    codeHash: text().notNull(),
    expiresAt: timestamptz().notNull(),
    attempts: integer().notNull().default(0),
    consumedAt: timestamptz(),
    ...timestamps(),
  },
  (table) => [index('otp_codes_user_purpose').on(table.userId, table.purpose)],
)
