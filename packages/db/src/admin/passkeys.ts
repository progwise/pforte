import { and, count, desc, eq, isNull, lt } from 'drizzle-orm'
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
  /** The person a new passkey is for. Left out for a sign-in, where the passkey says who it is. */
  userId?: string
  /** Where the question is asked, and the only place its answer is taken; see the table. */
  boundTo: string
}

const sameQuestion = ({ challenge, userId, boundTo }: PasskeyChallenge) =>
  and(eq(passkeyChallenges.challenge, challenge), eq(passkeyChallenges.boundTo, boundTo), userId ? eq(passkeyChallenges.userId, userId) : isNull(passkeyChallenges.userId))

/**
 * Notes a question a device is about to be asked. What has run out in the same place is cleared away on the
 * occasion. With `only`, every other question of that place goes too: a sign-in page that is shown again has one
 * question, the newest.
 */
export const openPasskeyChallenge = async (
  db: DatabaseOrTransaction,
  { challenge, userId, boundTo }: PasskeyChallenge,
  expiresAt: Date,
  { now = new Date(), only = false }: { now?: Date; only?: boolean } = {},
) => {
  await db.delete(passkeyChallenges).where(and(eq(passkeyChallenges.boundTo, boundTo), only ? undefined : lt(passkeyChallenges.expiresAt, now)))
  await db.insert(passkeyChallenges).values({ challenge, userId, boundTo, expiresAt })
}

/**
 * Uses a question up: true if it was asked in this place (and, for a new passkey, of this person) and has not
 * run out. The row is deleted in the same statement, so of two answers that name it, also at the same moment,
 * one finds it and the other does not. A question of another place or person is not touched.
 */
export const takePasskeyChallenge = async (db: DatabaseOrTransaction, question: PasskeyChallenge, now = new Date()) => {
  const [taken] = await db.delete(passkeyChallenges).where(sameQuestion(question)).returning({ expiresAt: passkeyChallenges.expiresAt })
  return taken !== undefined && taken.expiresAt > now
}

/** Deletes the questions nobody answered in time. Returns how many. */
export const deleteExpiredPasskeyChallenges = async (db: Database, now = new Date()) => {
  const deleted = await db.delete(passkeyChallenges).where(lt(passkeyChallenges.expiresAt, now)).returning({ challenge: passkeyChallenges.challenge })
  return deleted.length
}

/** The passkey a device names when it signs in, with what is needed to check its signature, or undefined. */
export const findPasskeyByCredentialId = async (db: DatabaseOrTransaction, credentialId: string) => {
  const [passkey] = await db
    .select({ id: passkeys.id, userId: passkeys.userId, credentialId: passkeys.credentialId, publicKey: passkeys.publicKey, counter: passkeys.counter, transports: passkeys.transports })
    .from(passkeys)
    .where(eq(passkeys.credentialId, credentialId))
  return passkey
}

/** Notes a sign-in with a passkey: when, the counter its device reported, and whether it is synced now. */
export const recordPasskeyUse = async (db: DatabaseOrTransaction, passkeyId: string, { counter, synced }: { counter: number; synced: boolean }, now = new Date()) => {
  await db.update(passkeys).set({ counter, synced, lastUsedAt: now }).where(eq(passkeys.id, passkeyId))
}
