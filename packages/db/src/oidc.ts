import { and, asc, eq } from 'drizzle-orm'
import type { Database } from './index.js'
import { claimTypes, clientClaimTypes, clients, oidcPayloads, userClaims, users } from './schema/index.js'

export type OidcPayload = Record<string, unknown>

const optionalString = (value: unknown) => (typeof value === 'string' ? value : null)

/**
 * Storage behind the node-oidc-provider adapter. `type` is the adapter's numeric model type,
 * so this module does not need to know the model names.
 */
export const createOidcPayloadStore = (db: Database) => {
  const withConsumed = (row: typeof oidcPayloads.$inferSelect): OidcPayload => ({
    ...(row.payload as OidcPayload),
    ...(row.consumedAt ? { consumed: Math.floor(row.consumedAt.getTime() / 1000) } : {}),
  })

  return {
    async upsert(id: string, type: number, payload: OidcPayload, expiresInSeconds?: number) {
      const values = {
        payload,
        grantId: optionalString(payload.grantId),
        userCode: optionalString(payload.userCode),
        uid: optionalString(payload.uid),
        expiresAt: expiresInSeconds ? new Date(Date.now() + expiresInSeconds * 1000) : null,
      }
      await db
        .insert(oidcPayloads)
        .values({ id, type, ...values })
        .onConflictDoUpdate({ target: [oidcPayloads.id, oidcPayloads.type], set: values })
    },

    async find(id: string, type: number) {
      const [row] = await db
        .select()
        .from(oidcPayloads)
        .where(and(eq(oidcPayloads.id, id), eq(oidcPayloads.type, type)))
      return row && withConsumed(row)
    },

    async findByUid(uid: string, type: number) {
      const [row] = await db
        .select()
        .from(oidcPayloads)
        .where(and(eq(oidcPayloads.uid, uid), eq(oidcPayloads.type, type)))
      return row && withConsumed(row)
    },

    async findByUserCode(userCode: string, type: number) {
      const [row] = await db
        .select()
        .from(oidcPayloads)
        .where(and(eq(oidcPayloads.userCode, userCode), eq(oidcPayloads.type, type)))
      return row && withConsumed(row)
    },

    async consume(id: string, type: number) {
      await db
        .update(oidcPayloads)
        .set({ consumedAt: new Date() })
        .where(and(eq(oidcPayloads.id, id), eq(oidcPayloads.type, type)))
    },

    async destroy(id: string, type: number) {
      await db.delete(oidcPayloads).where(and(eq(oidcPayloads.id, id), eq(oidcPayloads.type, type)))
    },

    /** Removes every token and code issued under a grant, e.g. on refresh token reuse. */
    async revokeByGrantId(grantId: string) {
      await db.delete(oidcPayloads).where(eq(oidcPayloads.grantId, grantId))
    },
  }
}

export const findClientById = async (db: Database, clientId: string) => {
  const [client] = await db.select().from(clients).where(eq(clients.clientId, clientId))
  return client
}

export const listClaimTypes = (db: Database) => db.select().from(claimTypes).orderBy(asc(claimTypes.key))

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Only active users can sign in or hold valid tokens. Returns undefined for anything else. */
export const findActiveUserById = async (db: Database, id: string) => {
  if (!UUID.test(id)) return undefined
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, id), eq(users.status, 'active')))
  return user
}

/**
 * The claims of a user that a client may receive: only claim types allowed for the client.
 * Multi-valued types are arrays, single-valued ones a string.
 */
export const getClaimsForClient = async (db: Database, userId: string, clientId: string) => {
  const rows = await db
    .select({
      key: userClaims.claimTypeKey,
      value: userClaims.value,
      multiValued: claimTypes.multiValued,
    })
    .from(userClaims)
    .innerJoin(claimTypes, eq(claimTypes.key, userClaims.claimTypeKey))
    .innerJoin(
      clientClaimTypes,
      and(eq(clientClaimTypes.claimTypeKey, userClaims.claimTypeKey), eq(clientClaimTypes.clientId, clientId)),
    )
    .where(eq(userClaims.userId, userId))
    .orderBy(asc(userClaims.claimTypeKey), asc(userClaims.value))

  const claims: Record<string, string | string[]> = {}
  for (const { key, value, multiValued } of rows) {
    if (multiValued) {
      const values = claims[key]
      claims[key] = Array.isArray(values) ? [...values, value] : [value]
    } else if (!(key in claims)) {
      claims[key] = value
    }
  }
  return claims
}
