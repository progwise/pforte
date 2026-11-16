import { and, count, desc, eq, lt } from 'drizzle-orm'
import { type DatabaseOrTransaction, recordAuditEvent, type Transaction } from '../audit.js'
import type { Database } from '../index.js'
import { passkeyChallenges, passkeys, users } from '../schema/index.js'
import type { RequestContext } from './users.js'

type UserRow = typeof users.$inferSelect

/** How many passkeys one person may have. More than anybody needs; it keeps the list a device is asked about short. */
export const MAX_PASSKEYS = 20

const audit = (context: RequestContext, action: string, user: UserRow, details: Record<string, unknown>) => ({
  actor: context.actor,
  ip: context.ip,
  userAgent: context.userAgent,
  action,
  target: { type: 'user', id: user.id },
  details: { email: user.email, ...details, ...(context.self ? { self: true } : {}) },
})

/** The passkeys of a user, newest first. */
export const listPasskeys = (db: DatabaseOrTransaction, userId: string) =>
  db
    .select({
      id: passkeys.id,
      credentialId: passkeys.credentialId,
      transports: passkeys.transports,
      synced: passkeys.synced,
      label: passkeys.label,
      createdAt: passkeys.createdAt,
      lastUsedAt: passkeys.lastUsedAt,
    })
    .from(passkeys)
    .where(eq(passkeys.userId, userId))
    .orderBy(desc(passkeys.createdAt), desc(passkeys.id))

export interface NewPasskey {
  credentialId: string
  publicKey: string
  counter: number
  transports: string[]
  synced: boolean
  label?: string
}

/**
 * Stores a passkey the person's device has just created. `duplicate` if the credential is known already (to this
 * person or to anybody else), `too-many` if the person has `MAX_PASSKEYS`.
 *
 * Needs a transaction: the person's row is locked until it ends, so that two passkeys arriving at the same moment
 * are counted one after the other and the limit holds.
 */
export const addPasskey = async (tx: Transaction, context: RequestContext, user: UserRow, passkey: NewPasskey) => {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for('update')
  const [existing] = await tx.select({ count: count() }).from(passkeys).where(eq(passkeys.userId, user.id))
  if ((existing?.count ?? 0) >= MAX_PASSKEYS) return { kind: 'too-many' } as const

  const [added] = await tx
    .insert(passkeys)
    .values({ userId: user.id, ...passkey, label: passkey.label?.slice(0, 100) })
    .onConflictDoNothing({ target: passkeys.credentialId })
    .returning({ id: passkeys.id, label: passkeys.label })
  if (!added) return { kind: 'duplicate' } as const
  await recordAuditEvent(tx, audit(context, 'user.passkey.add', user, { passkeyId: added.id, label: added.label, synced: passkey.synced }))
  return { kind: 'added', id: added.id, label: added.label } as const
}

/** Removes one passkey: it cannot sign in any more. Returns false if the user has no such passkey. */
export const removePasskey = async (tx: DatabaseOrTransaction, context: RequestContext, user: UserRow, passkeyId: string) => {
  const [removed] = await tx
    .delete(passkeys)
    .where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, user.id)))
    .returning({ id: passkeys.id, label: passkeys.label })
  if (!removed) return false
  await recordAuditEvent(tx, audit(context, 'user.passkey.remove', user, { passkeyId, label: removed.label }))
  return true
}

export interface PasskeyChallenge {
  challenge: string
  userId: string
  /** The sign-in at the account pages in which the question is asked. */
  grantId: string
}

/** Notes a question a device is about to be asked. What has run out for this person is cleared away on the occasion. */
export const openPasskeyChallenge = async (db: DatabaseOrTransaction, { challenge, userId, grantId }: PasskeyChallenge, expiresAt: Date, now = new Date()) => {
  await db.delete(passkeyChallenges).where(and(eq(passkeyChallenges.userId, userId), lt(passkeyChallenges.expiresAt, now)))
  await db.insert(passkeyChallenges).values({ challenge, userId, grantId, expiresAt })
}

/**
 * Uses a question up: true if it was asked of this person in this sign-in and has not run out. The row is
 * deleted in the same statement, so of two answers that name it, also at the same moment, one finds it and the
 * other does not. A question of somebody else, or of another sign-in, is not touched.
 */
export const takePasskeyChallenge = async (db: DatabaseOrTransaction, { challenge, userId, grantId }: PasskeyChallenge, now = new Date()) => {
  const [taken] = await db
    .delete(passkeyChallenges)
    .where(and(eq(passkeyChallenges.challenge, challenge), eq(passkeyChallenges.userId, userId), eq(passkeyChallenges.grantId, grantId)))
    .returning({ expiresAt: passkeyChallenges.expiresAt })
  return taken !== undefined && taken.expiresAt > now
}

/** Deletes the questions nobody answered in time. Returns how many. */
export const deleteExpiredPasskeyChallenges = async (db: Database, now = new Date()) => {
  const deleted = await db.delete(passkeyChallenges).where(lt(passkeyChallenges.expiresAt, now)).returning({ challenge: passkeyChallenges.challenge })
  return deleted.length
}
