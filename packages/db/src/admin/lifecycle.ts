import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { type DatabaseOrTransaction, recordAuditEvent } from '../audit.js'
import { MODEL_TYPES } from '../oidc.js'
import { clients, oidcPayloads, users } from '../schema/index.js'
import { assertAdminStays } from './admins.js'
import { revokeUserDevices } from './devices.js'
import { endPasskeySteps } from './passkeys.js'
import { lockUserRow } from '../users.js'
import { checkCode, type CodeCheck, type CodeOptions } from '../codes.js'
import type { Database } from '../index.js'
import type { RequestContext } from './users.js'

type UserRow = typeof users.$inferSelect
type Status = UserRow['status']

export type LifecycleAction = 'lock' | 'unlock' | 'activate' | 'deactivate' | 'reset-password' | 'end-sessions'

/** Thrown when an action is not allowed in the user's current state. */
export class LifecycleError extends Error {}

/** How long an activation link stays valid. */
export const ACTIVATION_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The lifecycle of a user:
 *
 *  created ──activate (sends the link; the user sets a password)──▶ active
 *  created / active ──lock──▶ locked ──unlock──▶ active (created if no password yet)
 * `unlock` also works for an active user, who is not locked: it changes nothing but lets them sign in again
 * after too many mistakes (the caller forgets the failed attempts).
 *  created / active / locked ──deactivate──▶ deactivated ──activate──▶ active (created if no password yet)
 *
 * `reset-password` and `end-sessions` need an active user and change no state.
 */
const ALLOWED: Record<LifecycleAction, Status[]> = {
  lock: ['created', 'active'],
  unlock: ['locked', 'active'],
  activate: ['created', 'deactivated'],
  deactivate: ['created', 'active', 'locked'],
  'reset-password': ['active'],
  'end-sessions': ['created', 'active', 'locked', 'deactivated'],
}

export const assertAllowed = (user: UserRow, action: LifecycleAction) => {
  if (!ALLOWED[action].includes(user.status)) {
    throw new LifecycleError(
      `Cannot ${action} a user who is ${user.status}. ${action} is possible for: ${ALLOWED[action].join(', ')}.`,
    )
  }
}

/**
 * One logout token to send: to this client, about this user. With `sid` it ends that one session at the client,
 * without it all sessions the client has of the user.
 */
export interface ClientLogout {
  clientId: string
  sid?: string
}

/**
 * The applications to tell that the sessions of a user ended (back-channel logout): every client with a logout
 * address that the user has a session with or was granted access to, which covers an application that kept
 * refreshing its tokens after the browser's session at pforte had expired. A client that asked for the session ID
 * (`backchannelLogoutSessionRequired`) gets one logout per session ID. Those IDs are in the browser sessions and
 * also in the tokens, which keep the ID of the session they came from through every refresh, so a session that is
 * gone at pforte but alive at the application is still named. Only a grant with neither leaves no ID to name, and
 * such a client is then not told. Every other client gets one logout, which means all its sessions of the user.
 * Must run before the records are deleted: they are the only place that knows.
 */
const logoutsFor = async (tx: DatabaseOrTransaction, userId: string, now = new Date()): Promise<ClientLogout[]> => {
  const rows = await tx
    .select({ type: oidcPayloads.type, payload: oidcPayloads.payload })
    .from(oidcPayloads)
    .where(
      and(
        eq(oidcPayloads.accountId, userId),
        inArray(oidcPayloads.type, [MODEL_TYPES.Session, MODEL_TYPES.Grant, MODEL_TYPES.RefreshToken, MODEL_TYPES.AccessToken]),
        or(isNull(oidcPayloads.expiresAt), gt(oidcPayloads.expiresAt, now)),
      ),
    )
  /** Per client the session IDs it knows the user by; empty for a client that only holds a grant. */
  const sessionIds = new Map<string, Set<string>>()
  const seen = (clientId: string) => sessionIds.get(clientId) ?? sessionIds.set(clientId, new Set()).get(clientId)!
  for (const row of rows) {
    const payload = row.payload as { authorizations?: Record<string, { sid?: unknown } | undefined>; clientId?: unknown; sid?: unknown }
    if (row.type === MODEL_TYPES.Session) {
      for (const [clientId, authorization] of Object.entries(payload.authorizations ?? {})) {
        const known = seen(clientId)
        if (typeof authorization?.sid === 'string') known.add(authorization.sid)
      }
    } else if (typeof payload.clientId === 'string') {
      // A grant names the client; a refresh or access token also the session it was issued in.
      const known = seen(payload.clientId)
      if (typeof payload.sid === 'string') known.add(payload.sid)
    }
  }
  if (sessionIds.size === 0) return []

  const listening = await tx
    .select({ clientId: clients.clientId, sessionRequired: clients.backchannelLogoutSessionRequired })
    .from(clients)
    .where(and(inArray(clients.clientId, [...sessionIds.keys()]), isNotNull(clients.backchannelLogoutUri)))
    .orderBy(clients.clientId)
  return listening.flatMap(({ clientId, sessionRequired }) =>
    sessionRequired ? [...sessionIds.get(clientId)!].sort().map((sid) => ({ clientId, sid })) : [{ clientId }],
  )
}

/** How many applications are told, for the audit event: several logouts for one client count once. */
const clientsToNotify = (logouts: ClientLogout[]) => new Set(logouts.map(({ clientId }) => clientId)).size

/**
 * Deletes every session, grant and token of a user and revokes their remembered devices, so they
 * must sign in again, with the second factor. What is under way ends too, none of it a session yet: a sign-in
 * between password and code (it is refused from now on, see `users.sessionEpoch`), a sign-in that is complete
 * but waits for the answer to the offer of a passkey, and every question about a passkey that is still open. Call it in a transaction. Returns how many of each went, how many applications are to be
 * told (for the audit event of the caller) and the logouts to send them once the change is committed.
 */
export const endUserSessions = async (tx: DatabaseOrTransaction, userId: string) => {
  // The person's row first, as with whatever keeps something for them on the strength of having just shown who
  // they are (see `lockUserRow`). So that is kept before this, and ended here, or it comes after and starts anew.
  await lockUserRow(tx, userId)
  // A sign-in that is under way (the password accepted, the code not yet) noted the count. It finds it changed.
  await tx.update(users).set({ sessionEpoch: sql`${users.sessionEpoch} + 1` }).where(eq(users.id, userId))
  const logouts = await logoutsFor(tx, userId)
  const deleted = await tx.delete(oidcPayloads).where(eq(oidcPayloads.accountId, userId)).returning({ id: oidcPayloads.id })
  await endPasskeySteps(tx, userId)
  return { sessionsEnded: deleted.length, devicesRevoked: await revokeUserDevices(tx, userId), clientsToNotify: clientsToNotify(logouts), logouts }
}

const audit = (context: RequestContext, action: string, user: UserRow, details: Record<string, unknown>) => ({
  actor: context.actor,
  ip: context.ip,
  userAgent: context.userAgent,
  action,
  target: { type: 'user', id: user.id },
  details: { email: user.email, ...details, ...(context.self ? { self: true } : {}) },
})

/** The state a user returns to when they stop being locked or deactivated: active only once they have a password. */
const restoredStatus = (user: UserRow): Status => (user.passwordHash ? 'active' : 'created')

const setStatus = async (tx: DatabaseOrTransaction, user: UserRow, values: Partial<typeof users.$inferInsert>) => {
  const [updated] = await tx.update(users).set(values).where(eq(users.id, user.id)).returning()
  return updated!
}

export const lockUser = async (tx: DatabaseOrTransaction, context: RequestContext, user: UserRow) => {
  assertAllowed(user, 'lock')
  await assertAdminStays(tx, context, user, 'lock')
  const updated = await setStatus(tx, user, { status: 'locked', lockedAt: new Date() })
  const { logouts, ...ended } = await endUserSessions(tx, user.id)
  await recordAuditEvent(tx, audit(context, 'user.lock', user, { from: user.status, to: 'locked', ...ended }))
  return { user: updated, logouts }
}

export const unlockUser = async (tx: DatabaseOrTransaction, context: RequestContext, user: UserRow) => {
  assertAllowed(user, 'unlock')
  if (user.status === 'active') {
    await recordAuditEvent(tx, audit(context, 'user.unlock', user, { from: 'active', to: 'active' }))
    return user
  }
  const to = restoredStatus(user)
  const updated = await setStatus(tx, user, { status: to, lockedAt: null })
  await recordAuditEvent(tx, audit(context, 'user.unlock', user, { from: 'locked', to }))
  return updated
}

export const deactivateUser = async (tx: DatabaseOrTransaction, context: RequestContext, user: UserRow) => {
  assertAllowed(user, 'deactivate')
  await assertAdminStays(tx, context, user, 'deactivate')
  // A pending activation link must not work for someone who was deactivated.
  const updated = await setStatus(tx, user, { status: 'deactivated', activationTokenHash: null, activationExpiresAt: null, activationClientId: null })
  const { logouts, ...ended } = await endUserSessions(tx, user.id)
  await recordAuditEvent(tx, audit(context, 'user.deactivate', user, { from: user.status, to: 'deactivated', ...ended }))
  return { user: updated, logouts }
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** Replaces the activation link of a user who has no password yet. The token is returned once; only its hash is stored. */
const issueActivationLink = async (tx: DatabaseOrTransaction, user: UserRow, clientId?: string) => {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + ACTIVATION_VALIDITY_MS)
  const updated = await setStatus(tx, user, {
    status: 'created',
    activationTokenHash: hashToken(token),
    activationExpiresAt: expiresAt,
    activationClientId: clientId ?? null,
  })
  return { token, expiresAt, updated }
}

/**
 * A person who has no password yet asks for their activation link themselves. Only for a `created` user (anything else
 * returns undefined); the new link replaces the earlier one, and `clientId` is the application the person came from. The audit event is `user.activation.request` with `self: true`.
 */
export const requestActivationLink = async (
  tx: DatabaseOrTransaction,
  context: RequestContext,
  user: UserRow,
  options: { clientId?: string } = {},
) => {
  if (user.status !== 'created') return undefined
  const { token, expiresAt, updated } = await issueActivationLink(tx, user, options.clientId)
  await recordAuditEvent(
    tx,
    audit(context, 'user.activation.request', user, { self: true, expiresAt: expiresAt.toISOString(), ...(options.clientId ? { clientId: options.clientId } : {}) }),
  )
  return { user: updated, activation: { token, expiresAt } }
}

/**
 * Starts activation. A user who never had a password gets a one-time link: the token is returned
 * once, for the notifier, and only its hash is stored. A deactivated user who already has a
 * password simply becomes active again.
 */
export const activateUser = async (tx: DatabaseOrTransaction, context: RequestContext, user: UserRow, options: { clientId?: string } = {}) => {
  assertAllowed(user, 'activate')

  if (user.status === 'deactivated' && user.passwordHash) {
    const updated = await setStatus(tx, user, { status: 'active' })
    await recordAuditEvent(tx, audit(context, 'user.activate', user, { from: 'deactivated', to: 'active', linkSent: false }))
    return { user: updated, activation: undefined }
  }

  const { token, expiresAt, updated } = await issueActivationLink(tx, user, options.clientId)
  // The audit event never contains the token.
  await recordAuditEvent(
    tx,
    audit(context, 'user.activate', user, { from: user.status, to: 'created', linkSent: true, expiresAt: expiresAt.toISOString(), ...(options.clientId ? { clientId: options.clientId } : {}) }),
  )
  return { user: updated, activation: { token, expiresAt } }
}

/** Asks for a password reset (the notifier sends the code) and ends all sessions, as the account may be compromised. */
export const requestPasswordReset = async (tx: DatabaseOrTransaction, context: RequestContext, user: UserRow) => {
  assertAllowed(user, 'reset-password')
  const { logouts, ...ended } = await endUserSessions(tx, user.id)
  await recordAuditEvent(tx, audit(context, 'user.password_reset.request', user, ended))
  return { user, logouts }
}

/**
 * A person enters the code that was sent to their phone number. If it is right, the number is confirmed and codes
 * can go there by SMS from now on.
 *
 * The code proves something about the number it was sent to, and about no other. So the person's row is held from
 * the first look at the number to the last write: the code is checked against the number that is stored at that
 * moment (it was issued bound to its destination), the confirmation is written and recorded, all or nothing. A
 * change of the number by the back office happens wholly before, and the code is then a wrong one, or wholly
 * after, and takes the confirmation away again. A wrong code still counts as an attempt.
 *
 * The row is held `for no key update`, which is what a change of the number waits for, and not `for update`: a
 * new code that is issued at the same moment ends the old one and then refers to this row (the foreign key of
 * the new code takes `for key share`). Under `for update` that one would wait for this, and this for the old
 * code it holds: a deadlock, and one of the two requests would fail.
 */
export const confirmPhone = (db: Database, context: RequestContext, { userId, code }: { userId: string; code: string }, options: CodeOptions): Promise<CodeCheck> =>
  db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('no key update')
    if (!user?.phone || user.phoneVerifiedAt) return { ok: false, reason: 'none' }
    const result = await checkCode(tx, { userId, purpose: 'activation', code, boundTo: user.phone }, options)
    if (!result.ok) return result
    await tx
      .update(users)
      .set({ phoneVerifiedAt: options.now ?? new Date() })
      .where(eq(users.id, userId))
    await recordAuditEvent(tx, audit(context, 'user.phone.confirm', user, {}))
    return result
  })

export const endSessions = async (tx: DatabaseOrTransaction, context: RequestContext, user: UserRow) => {
  assertAllowed(user, 'end-sessions')
  const { logouts, ...ended } = await endUserSessions(tx, user.id)
  await recordAuditEvent(tx, audit(context, 'user.sessions.end', user, ended))
  return { user, sessionsEnded: ended.sessionsEnded, devicesRevoked: ended.devicesRevoked, logouts }
}

export const activationTokenHash = hashToken
