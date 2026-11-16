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
  /**
   * Whether the application holds a refresh token under this grant, so that it stays signed in without the
   * browser. Every sign-in in a browser makes a grant; only this tells an app on a phone from a page that is
   * signed in as long as its browser session lasts.
   */
  staysSignedIn: boolean
}

/**
 * Where a user is signed in right now: the browser sessions (single sign-on) and the applications that were granted
 * access and stay signed in, such as an app on a phone. Neither the identifiers of the sessions nor any token is
 * returned, only what an administrator needs to see: since when, until when, and where.
 */
export const listUserSessions = async (db: DatabaseOrTransaction, userId: string, now = new Date()) => {
  const rows = await db
    .select({ id: oidcPayloads.id, type: oidcPayloads.type, payload: oidcPayloads.payload, grantId: oidcPayloads.grantId, consumedAt: oidcPayloads.consumedAt, createdAt: oidcPayloads.createdAt, expiresAt: oidcPayloads.expiresAt })
    .from(oidcPayloads)
    .where(
      and(
        eq(oidcPayloads.accountId, userId),
        inArray(oidcPayloads.type, [MODEL_TYPES.Session, MODEL_TYPES.Grant, MODEL_TYPES.RefreshToken]),
        or(isNull(oidcPayloads.expiresAt), gt(oidcPayloads.expiresAt, now)),
      ),
    )

  // A refresh token that was exchanged for a new one stays in the table, marked as used, until it expires.
  const refreshable = new Set(rows.filter((row) => row.type === MODEL_TYPES.RefreshToken && row.consumedAt === null && row.grantId).map((row) => row.grantId))
  const sessions: UserSession[] = []
  const grants: UserGrant[] = []
  for (const row of rows) {
    if (row.type === MODEL_TYPES.RefreshToken) continue
    const payload = row.payload as { loginTs?: number; acr?: string; authorizations?: Record<string, unknown>; clientId?: string }
    if (row.type === MODEL_TYPES.Session) {
      sessions.push({
        startedAt: typeof payload.loginTs === 'number' ? new Date(payload.loginTs * 1000) : row.createdAt,
        expiresAt: row.expiresAt,
        acr: payload.acr ?? null,
        clientIds: Object.keys(payload.authorizations ?? {}).sort(),
      })
    } else if (payload.clientId) {
      grants.push({ clientId: payload.clientId, since: row.createdAt, expiresAt: row.expiresAt, staysSignedIn: refreshable.has(row.id) })
    }
  }
  sessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
  grants.sort((a, b) => a.clientId.localeCompare(b.clientId))
  return { sessions, grants }
}

/**
 * Whether the user is signed in to this application right now: a browser session that includes it, or a grant
 * for it. After the sessions of a user were ended, this is true again only if they signed in anew.
 */
export const isSignedInTo = async (db: DatabaseOrTransaction, userId: string, clientId: string, now = new Date()) => {
  const { sessions, grants } = await listUserSessions(db, userId, now)
  return sessions.some((session) => session.clientIds.includes(clientId)) || grants.some((grant) => grant.clientId === clientId)
}

/**
 * The grant an access token was issued under: the record of one sign-in of a user to one application in one
 * browser. It is deleted when that sign-in ends (signing out at pforte, ending the user's sessions), and a later
 * sign-in gets a new one, so it tells this sign-in from every other of the same person.
 */
export const findGrantOfAccessToken = async (db: DatabaseOrTransaction, token: string, now = new Date()) => {
  const [row] = await db
    .select({ grantId: oidcPayloads.grantId, userId: oidcPayloads.accountId, payload: oidcPayloads.payload })
    .from(oidcPayloads)
    .where(and(eq(oidcPayloads.id, token), eq(oidcPayloads.type, MODEL_TYPES.AccessToken), or(isNull(oidcPayloads.expiresAt), gt(oidcPayloads.expiresAt, now))))
  const clientId = (row?.payload as { clientId?: unknown } | undefined)?.clientId
  return row?.grantId && row.userId && typeof clientId === 'string' ? { grantId: row.grantId, userId: row.userId, clientId } : undefined
}

/** Whether this grant still exists, for this user and this application. */
export const isGrantLive = async (db: DatabaseOrTransaction, grant: { grantId: string; userId: string; clientId: string }, now = new Date()) => {
  const [row] = await db
    .select({ payload: oidcPayloads.payload })
    .from(oidcPayloads)
    .where(
      and(
        eq(oidcPayloads.id, grant.grantId),
        eq(oidcPayloads.type, MODEL_TYPES.Grant),
        eq(oidcPayloads.accountId, grant.userId),
        or(isNull(oidcPayloads.expiresAt), gt(oidcPayloads.expiresAt, now)),
      ),
    )
  return (row?.payload as { clientId?: unknown } | undefined)?.clientId === grant.clientId
}
