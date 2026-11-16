import { createHash, randomBytes } from 'node:crypto'
import { and, count, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import { type DatabaseOrTransaction, recordAuditEvent, type Transaction } from '../audit.js'
import type { Database } from '../index.js'
import { passkeyChallenges, passkeyOffers, passkeys, users } from '../schema/index.js'
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
 *
 * `allowed` is asked once the row is locked, in the same transaction: whether what entitles the person to a new
 * passkey still holds (the offer is open, the sign-in exists). Ending a person's sessions locks the same row, so
 * it has either happened by then, and the answer is no (`revoked`), or it waits until the passkey is stored.
 * Whatever `allowed` changes (closing the offer) is committed with the passkey or not at all.
 */
export const addPasskey = async (tx: Transaction, context: RequestContext, user: UserRow, passkey: NewPasskey, allowed?: (tx: Transaction) => Promise<boolean>) => {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for('update')
  if (allowed && !(await allowed(tx))) return { kind: 'revoked' } as const
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

/**
 * Notes a sign-in with a passkey: when, the counter its device reported, and whether it is synced now. True if it
 * was noted, and only then may the sign-in go on.
 *
 * `passkey` is the passkey as the signature was checked against it. The note is made only if the passkey is still
 * there and its counter is still the one that was checked: of two sign-ins that were checked against the same
 * counter, the second finds it changed, so a counter never goes back, and a passkey that was removed meanwhile
 * signs nobody in. A passkey that does not count (its counter stays 0, as with synced passkeys) is not held up.
 */
export const recordPasskeyUse = async (
  db: DatabaseOrTransaction,
  passkey: { id: string; counter: number },
  { counter, synced }: { counter: number; synced: boolean },
  now = new Date(),
) => {
  const noted = await db
    .update(passkeys)
    .set({ counter, synced, lastUsedAt: now })
    .where(and(eq(passkeys.id, passkey.id), eq(passkeys.counter, passkey.counter)))
    .returning({ id: passkeys.id })
  return noted.length === 1
}

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')

export interface PasskeyOffer {
  /** What the browser holds. */
  token: string
  /** Where the offer is made; see the table. */
  boundTo: string
}

/** Notes that this person is being offered a passkey in this place, and returns the token for their browser. */
export const openPasskeyOffer = async (db: DatabaseOrTransaction, { userId, boundTo, details }: { userId: string; boundTo: string; details: Record<string, unknown> }, expiresAt: Date) => {
  const token = randomBytes(32).toString('base64url')
  await db.insert(passkeyOffers).values({ tokenHash: hashOf(token), userId, boundTo, details, expiresAt })
  return token
}

const sameOffer = ({ token, boundTo }: PasskeyOffer) => and(eq(passkeyOffers.tokenHash, hashOf(token)), eq(passkeyOffers.boundTo, boundTo))

/** The offer this token stands for in this place, if it is still open: who it is made to, and what the place noted. */
export const findPasskeyOffer = async (db: DatabaseOrTransaction, offer: PasskeyOffer, now = new Date()) => {
  const [open] = await db.select({ userId: passkeyOffers.userId, details: passkeyOffers.details, expiresAt: passkeyOffers.expiresAt }).from(passkeyOffers).where(sameOffer(offer))
  return open && open.expiresAt > now ? { userId: open.userId, details: open.details } : undefined
}

/**
 * Ends an offer because it was answered, and returns it if it was still open. The row is deleted in the same
 * statement: of two answers, also at the same moment, one gets it, and a copy of the token is worth nothing after.
 */
export const closePasskeyOffer = async (db: DatabaseOrTransaction, offer: PasskeyOffer, now = new Date()) => {
  const [closed] = await db.delete(passkeyOffers).where(sameOffer(offer)).returning({ userId: passkeyOffers.userId, details: passkeyOffers.details, expiresAt: passkeyOffers.expiresAt })
  return closed && closed.expiresAt > now ? { userId: closed.userId, details: closed.details } : undefined
}

/**
 * Carries an offer that was opened earlier on to its next step: more is noted about it (merged into what is there)
 * and it runs until `expiresAt`. False if it is not open any more; nothing is opened in its place.
 */
export const continuePasskeyOffer = async (db: DatabaseOrTransaction, offer: PasskeyOffer, { details, expiresAt }: { details: Record<string, unknown>; expiresAt: Date }, now = new Date()) => {
  const continued = await db
    .update(passkeyOffers)
    .set({ details: sql`${passkeyOffers.details} || ${JSON.stringify(details)}::jsonb`, expiresAt })
    .where(and(sameOffer(offer), gt(passkeyOffers.expiresAt, now)))
    .returning({ userId: passkeyOffers.userId })
  return continued.length === 1
}

/**
 * Ends what a person has open about passkeys: offers that wait for an answer (with the sign-in behind them) and
 * questions their devices have not answered. Part of ending a person's sessions, so that nothing that was begun
 * before can be finished after.
 */
export const endPasskeySteps = async (tx: DatabaseOrTransaction, userId: string) => {
  await tx.delete(passkeyOffers).where(eq(passkeyOffers.userId, userId))
  await tx.delete(passkeyChallenges).where(eq(passkeyChallenges.userId, userId))
}

/** Deletes the offers nobody answered in time. Returns how many. */
export const deleteExpiredPasskeyOffers = async (db: Database, now = new Date()) => {
  const deleted = await db.delete(passkeyOffers).where(lt(passkeyOffers.expiresAt, now)).returning({ tokenHash: passkeyOffers.tokenHash })
  return deleted.length
}
