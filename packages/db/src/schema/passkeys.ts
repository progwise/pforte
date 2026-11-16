import { bigint, boolean, index, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { id, timestamps, timestamptz } from './columns.js'
import { users } from './users.js'

/**
 * Passkeys (WebAuthn credentials) of a user: the public half of a key pair whose private half never leaves the
 * person's device or password manager. Nothing in a row is a secret.
 */
export const passkeys = pgTable(
  'passkeys',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The id the authenticator gave the credential, base64url. It is what a sign-in names. */
    credentialId: text().notNull().unique('passkeys_credential_id_unique'),
    /** The public key in COSE format, base64url. */
    publicKey: text().notNull(),
    /** The signature counter the authenticator reported last. Synced passkeys always report 0. */
    counter: bigint({ mode: 'number' }).notNull().default(0),
    /** How the authenticator can be reached (`internal`, `hybrid`, `usb`, ...), as the browser reported it. */
    transports: text().array().notNull().default([]),
    /** Whether the passkey is synced to the person's other devices (iCloud Keychain, Google Password Manager). */
    synced: boolean().notNull().default(false),
    /** For the lists: browser and system the passkey was created with, such as "Safari on iPhone". */
    label: text(),
    lastUsedAt: timestamptz(),
    ...timestamps(),
  },
  (table) => [index('passkeys_user_id').on(table.userId)],
)

/**
 * The questions devices were asked, until their answers come back: to make a passkey, or to sign in with one.
 * A question is good for one answer: the row is deleted by the answer that names it, so the same answer cannot be
 * sent again, also not after its passkey was removed.
 */
export const passkeyChallenges = pgTable(
  'passkey_challenges',
  {
    /** The random value the device signs, base64url. */
    challenge: text().primaryKey(),
    /** The person a new passkey is for. Empty for a sign-in, where the passkey says who it is. */
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Where the question was asked, and the only place its answer is taken: a sign-in at the account pages
     * (`account:<grant>`), a sign-in in progress (`sign-in:<interaction>`, `offer:<interaction>`) or an
     * activation (`activation:<user>`).
     */
    boundTo: text().notNull(),
    expiresAt: timestamptz().notNull(),
    ...timestamps(),
  },
  (table) => [index('passkey_challenges_bound_to').on(table.boundTo), index('passkey_challenges_expires_at').on(table.expiresAt)],
)
