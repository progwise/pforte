import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm'
import type { DatabaseOrTransaction } from '../audit.js'
import { MODEL_TYPES } from '../oidc.js'
import { oidcPayloads } from '../schema/index.js'

export interface UserSession {
  startedAt: Date
  expiresAt: Date | null
  /** The assurance of the sign-in, e.g. `urn:pforte:acr:mfa` when a code was entered. */
  acr: string | null
  /** The applications this browser is signed in to. */
  clientIds: string[]
}

export interface UserGrant {
  clientId: string
  since: Date
  expiresAt: Date | null
}

/**
 * Where a user is signed in right now: the browser sessions (single sign-on) and the applications that were granted
 * access and stay signed in, such as an app on a phone. Neither the identifiers of the sessions nor any token is
 * returned, only what an administrator needs to see: since when, until when, and where.
 */
export const listUserSessions = async (db: DatabaseOrTransaction, userId: string, now = new Date()) => {
  const rows = await db
    .select({ type: oidcPayloads.type, payload: oidcPayloads.payload, createdAt: oidcPayloads.createdAt, expiresAt: oidcPayloads.expiresAt })
    .from(oidcPayloads)
    .where(
      and(
        eq(oidcPayloads.accountId, userId),
        inArray(oidcPayloads.type, [MODEL_TYPES.Session, MODEL_TYPES.Grant]),
        or(isNull(oidcPayloads.expiresAt), gt(oidcPayloads.expiresAt, now)),
      ),
    )

  const sessions: UserSession[] = []
  const grants: UserGrant[] = []
  for (const row of rows) {
    const payload = row.payload as { loginTs?: number; acr?: string; authorizations?: Record<string, unknown>; clientId?: string }
    if (row.type === MODEL_TYPES.Session) {
      sessions.push({
        startedAt: typeof payload.loginTs === 'number' ? new Date(payload.loginTs * 1000) : row.createdAt,
        expiresAt: row.expiresAt,
        acr: payload.acr ?? null,
        clientIds: Object.keys(payload.authorizations ?? {}).sort(),
      })
    } else if (payload.clientId) {
      grants.push({ clientId: payload.clientId, since: row.createdAt, expiresAt: row.expiresAt })
    }
  }
  sessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
  grants.sort((a, b) => a.clientId.localeCompare(b.clientId))
  return { sessions, grants }
}
