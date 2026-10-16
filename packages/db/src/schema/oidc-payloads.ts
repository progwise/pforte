import { index, integer, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import { timestamps, timestamptz } from './columns.js'

/**
 * Storage for the node-oidc-provider models (sessions, grants, tokens, interactions),
 * used by its Postgres adapter. `type` is the adapter's numeric model type.
 */
export const oidcPayloads = pgTable(
  'oidc_payloads',
  {
    id: text().notNull(),
    type: integer().notNull(),
    payload: jsonb().notNull(),
    grantId: text(),
    userCode: text(),
    uid: text(),
    expiresAt: timestamptz(),
    consumedAt: timestamptz(),
    ...timestamps(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.type] }),
    index('oidc_payloads_grant_id').on(table.grantId),
    index('oidc_payloads_user_code').on(table.userCode),
    index('oidc_payloads_uid').on(table.uid),
    index('oidc_payloads_expires_at').on(table.expiresAt),
  ],
)
