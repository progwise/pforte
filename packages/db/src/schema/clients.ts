import { sql } from 'drizzle-orm'
import { boolean, check, integer, pgEnum, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import { claimTypes } from './claims.js'
import { timestamps } from './columns.js'

export const clientType = pgEnum('client_type', ['public', 'confidential'])

export const clients = pgTable(
  'clients',
  {
    /** The OIDC client_id, a string chosen by the administrator. */
    clientId: text().primaryKey(),
    name: text().notNull(),
    type: clientType().notNull(),
    /** Hash of the client secret. Required for confidential clients. */
    secretHash: text(),
    redirectUris: text().array().notNull().default(sql`'{}'`),
    postLogoutRedirectUris: text().array().notNull().default(sql`'{}'`),
    /** Where pforte sends back-channel logout tokens when a session ends. Null disables it. */
    backchannelLogoutUri: text(),
    backchannelLogoutSessionRequired: boolean().notNull().default(false),
    allowedGrants: text()
      .array()
      .notNull()
      .default(sql`'{authorization_code,refresh_token}'`),
    /** Token lifetimes in seconds. Null means the server default. */
    accessTokenTtlSeconds: integer(),
    idTokenTtlSeconds: integer(),
    refreshTokenTtlSeconds: integer(),
    ...timestamps(),
  },
  (table) => [
    check(
      'clients_confidential_has_secret',
      sql`${table.type} = 'public' or ${table.secretHash} is not null`,
    ),
  ],
)

/** Which claim types a client receives in the ID token and userinfo. */
export const clientClaimTypes = pgTable(
  'client_claim_types',
  {
    clientId: text()
      .notNull()
      .references(() => clients.clientId, { onDelete: 'cascade' }),
    claimTypeKey: text()
      .notNull()
      .references(() => claimTypes.key, { onDelete: 'cascade' }),
    ...timestamps(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.claimTypeKey] })],
)
