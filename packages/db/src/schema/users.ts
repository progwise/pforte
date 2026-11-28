import { sql } from 'drizzle-orm'
import { boolean, check, integer, pgEnum, pgTable, text } from 'drizzle-orm/pg-core'
import { clients } from './clients.js'
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
    /**
     * Set when the person chose the number themselves, on the account pages. From then on the number is theirs: a
     * sync or an import that names another one leaves it alone (the upsert by e-mail address). An administrator
     * can still correct it, and it stays the person's after that.
     */
    phoneSetByUserAt: timestamptz(),
    /** Set when the user proves they own the address: with the activation link or a code sent by e-mail. */
    emailVerifiedAt: timestamptz(),
    firstName: text().notNull(),
    lastName: text().notNull(),
    language: text().notNull().default('en'),
    status: userStatus().notNull().default('created'),
    isAdmin: boolean().notNull().default(false),
    lockedAt: timestamptz(),
    lastLoginAt: timestamptz(),
    /**
     * Counts how often this person's sessions were ended: by "sign out everywhere", a password reset, locking,
     * deactivating. A sign-in that is under way notes the count when the password is accepted and is refused if
     * it has moved on since, so what was begun before the sessions were ended cannot be finished after.
     */
    sessionEpoch: integer().notNull().default(0),
    /** Hash of the activation token; the token itself is only sent by e-mail. */
    activationTokenHash: text().unique('users_activation_token_hash_unique'),
    activationExpiresAt: timestamptz(),
    /** The application the person was invited to, so that the page after choosing a password can lead there. */
    activationClientId: text().references(() => clients.clientId, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (table) => [check('users_email_lowercase', sql`${table.email} = lower(${table.email})`)],
)
