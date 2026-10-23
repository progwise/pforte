import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { type DatabaseOrTransaction, recordAuditEvent } from '../audit.js'
import { oidcPayloads, users } from '../schema/index.js'
import { assertAdminStays } from './admins.js'
import { revokeUserDevices } from './devices.js'
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
 * Deletes every session, grant and token of a user and revokes their remembered devices, so they
 * must sign in again, with the second factor. Returns how many of each went.
 */
export const endUserSessions = async (tx: DatabaseOrTransaction, userId: string) => {
  const deleted = await tx.delete(oidcPayloads).where(eq(oidcPayloads.accountId, userId)).returning({ id: oidcPayloads.id })
  return { sessionsEnded: deleted.length, devicesRevoked: await revokeUserDevices(tx, userId) }
}

const audit = (context: RequestContext, action: string, user: UserRow, details: Record<string, unknown>) => ({
  actor: context.actor,
  ip: context.ip,
  userAgent: context.userAgent,
  action,
  target: { type: 'user', id: user.id },
  details: { email: user.email, ...details },
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
  const { sessionsEnded, devicesRevoked } = await endUserSessions(tx, user.id)
  await recordAuditEvent(tx, audit(context, 'user.lock', user, { from: user.status, to: 'locked', sessionsEnded, devicesRevoked }))
  return updated
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
  const { sessionsEnded, devicesRevoked } = await endUserSessions(tx, user.id)
  await recordAuditEvent(tx, audit(context, 'user.deactivate', user, { from: user.status, to: 'deactivated', sessionsEnded, devicesRevoked }))
  return updated
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
 * returns undefined); the new link replaces the earlier one. The audit event is `user.activation.request` with `self: true`.
 */
export const requestActivationLink = async (tx: DatabaseOrTransaction, context: RequestContext, user: UserRow) => {
  if (user.status !== 'created') return undefined
  const { token, expiresAt, updated } = await issueActivationLink(tx, user)
  await recordAuditEvent(tx, audit(context, 'user.activation.request', user, { self: true, expiresAt: expiresAt.toISOString() }))
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
  const { sessionsEnded, devicesRevoked } = await endUserSessions(tx, user.id)
  await recordAuditEvent(tx, audit(context, 'user.password_reset.request', user, { sessionsEnded, devicesRevoked }))
  return user
}

export const endSessions = async (tx: DatabaseOrTransaction, context: RequestContext, user: UserRow) => {
  assertAllowed(user, 'end-sessions')
  const { sessionsEnded, devicesRevoked } = await endUserSessions(tx, user.id)
  await recordAuditEvent(tx, audit(context, 'user.sessions.end', user, { sessionsEnded, devicesRevoked }))
  return { user, sessionsEnded, devicesRevoked }
}

export const activationTokenHash = hashToken
