import { boolean, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { id, timestamps } from './columns.js'
import { users } from './users.js'

export const claimTypes = pgTable('claim_types', {
  /** Claim name in tokens, e.g. partner_no. */
  key: text().primaryKey(),
  description: text().notNull().default(''),
  /** Regular expression a value must match. Null means any value. */
  valuePattern: text(),
  /** Single-valued types are enforced by the application, not the database. */
  multiValued: boolean().notNull().default(false),
  ...timestamps(),
})

export const userClaims = pgTable(
  'user_claims',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    claimTypeKey: text()
      .notNull()
      .references(() => claimTypes.key, { onDelete: 'restrict' }),
    value: text().notNull(),
    ...timestamps(),
  },
  (table) => [
    unique('user_claims_user_type_value').on(table.userId, table.claimTypeKey, table.value),
    // Search users by claim value in the admin UI.
    index('user_claims_type_value').on(table.claimTypeKey, table.value),
  ],
)
