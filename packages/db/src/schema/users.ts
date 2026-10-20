import { sql } from 'drizzle-orm'
import { boolean, check, pgEnum, pgTable, text } from 'drizzle-orm/pg-core'
import { id, timestamps, timestamptz } from './columns.js'

export const userStatus = pgEnum('user_status', ['created', 'active', 'locked', 'deactivated'])

export const users = pgTable(
  'users',
  {
    id: id(),
    /** Login name. Stored lowercase; the application normalizes on write. */
    email: text().notNull().unique(),
    /** argon2id hash. Null until the user has activated the account. */
    passwordHash: text(),
    /** E.164, e.g. +4915112345678. */
    phone: text(),
    phoneVerifiedAt: timestamptz(),
    /** Set when the user proves they own the address: with the activation link or a code sent by e-mail. */
    emailVerifiedAt: timestamptz(),
    firstName: text().notNull(),
    lastName: text().notNull(),
    language: text().notNull().default('en'),
    status: userStatus().notNull().default('created'),
    isAdmin: boolean().notNull().default(false),
    lockedAt: timestamptz(),
    lastLoginAt: timestamptz(),
    /** Hash of the activation token; the token itself is only sent by e-mail. */
    activationTokenHash: text().unique('users_activation_token_hash_unique'),
    activationExpiresAt: timestamptz(),
    ...timestamps(),
  },
  (table) => [check('users_email_lowercase', sql`${table.email} = lower(${table.email})`)],
)
