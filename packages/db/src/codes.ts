import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import type { DatabaseOrTransaction } from './audit.js'
import type { Database } from './index.js'
import { otpCodes, users } from './schema/index.js'

type Channel = (typeof otpCodes.$inferInsert)['channel']
type Purpose = (typeof otpCodes.$inferInsert)['purpose']

export const CODE_LENGTH = 6
export const CODE_LIFETIME_MS = 10 * 60 * 1000
export const MAX_ATTEMPTS = 5
export const RESEND_COOLDOWN_MS = 60 * 1000
export const MAX_CODES_PER_HOUR = 5

/** Why no code could be issued. `retryAfterSeconds` tells the user when to try again. */
export class CodeLimitError extends Error {
  constructor(
    readonly reason: 'cooldown' | 'too_many',
    readonly retryAfterSeconds: number,
  ) {
    super(reason === 'cooldown' ? 'A code was sent a moment ago.' : 'Too many codes were requested.')
  }
}

/**
 * The code is bound to the user and the purpose, so a code for one cannot be used for the other.
 * An HMAC with a server secret, because a plain hash of six digits can be reversed in a moment.
 *
 * `boundTo` binds it to one thing more, such as the phone number it was sent to: the code then proves something
 * about that number only, and is a wrong code once the user has another. It is part of what is signed, so it is
 * stored with the code without being kept in a second place. Its form differs from the one without, so that
 * nothing typed into a code field can pass for it.
 */
const sign = (secret: string, userId: string, purpose: Purpose, code: string, boundTo?: string) =>
  createHmac('sha256', secret)
    .update(boundTo === undefined ? `${userId}:${purpose}:${code}` : JSON.stringify([userId, purpose, code, boundTo]))
    .digest('hex')

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export interface CodeOptions {
  /** Secrets to sign with. The first one signs; all of them verify, so a secret can be rotated. */
  secrets: string[]
  now?: Date
}

/**
 * Creates a code for the user and returns it so it can be sent; only its signature is stored. A new
 * code replaces earlier ones for the same purpose. Limits how often codes can be requested, since
 * every code costs a message and gives an attacker new guesses. Codes that were used successfully
 * do not count towards the limits.
 */
export const issueCode = async (
  db: Database,
  { userId, channel, purpose, boundTo }: { userId: string; channel: Channel; purpose: Purpose; boundTo?: string },
  { secrets, now = new Date() }: CodeOptions,
) =>
  db.transaction(async (tx) => {
    // Serialises concurrent requests for the same user, so the limits cannot be raced.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}:${purpose}`}, 0))`)

    const recent = await tx
      .select({ createdAt: otpCodes.createdAt })
      .from(otpCodes)
      .where(
        and(
          eq(otpCodes.userId, userId),
          eq(otpCodes.purpose, purpose),
          // Codes that were used count for nothing: signing in to several applications is normal.
          // Only codes that were sent and not used, which is what abuse looks like, are limited.
          isNull(otpCodes.consumedAt),
          gt(otpCodes.createdAt, new Date(now.getTime() - 60 * 60 * 1000)),
        ),
      )
      .orderBy(sql`${otpCodes.createdAt} desc`)
    const newest = recent[0]
    if (newest && now.getTime() - newest.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      throw new CodeLimitError('cooldown', Math.ceil((RESEND_COOLDOWN_MS - (now.getTime() - newest.createdAt.getTime())) / 1000))
    }
    if (recent.length >= MAX_CODES_PER_HOUR) {
      const oldest = recent[recent.length - 1]!
      throw new CodeLimitError('too_many', Math.ceil((oldest.createdAt.getTime() + 60 * 60 * 1000 - now.getTime()) / 1000))
    }

    await withdrawCode(tx, { userId, purpose }, now)

    const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0')
    const expiresAt = new Date(now.getTime() + CODE_LIFETIME_MS)
    await tx.insert(otpCodes).values({
      userId,
      channel,
      purpose,
      codeHash: sign(secrets[0]!, userId, purpose, code, boundTo),
      expiresAt,
      createdAt: now,
    })
    return { code, expiresAt }
  })

/**
 * Ends the code that is valid for the user and purpose: a new one takes its place, or it could not be sent and
 * nobody is waiting for it. It stays unused (`consumedAt` means "was used successfully") and still counts towards
 * the limits on asking for codes.
 */
export const withdrawCode = async (db: DatabaseOrTransaction, { userId, purpose }: { userId: string; purpose: Purpose }, now = new Date()) => {
  await db
    .update(otpCodes)
    .set({ expiresAt: now })
    .where(and(eq(otpCodes.userId, userId), eq(otpCodes.purpose, purpose), isNull(otpCodes.consumedAt), gt(otpCodes.expiresAt, now)))
}

/**
 * Ends the code as `withdrawCode` does, for a change that holds the user's row and makes the code useless: a new
 * phone number, which the code that is out is not bound to.
 *
 * It does not wait for a code that another request holds at that moment, and leaves that one alone. Only a
 * request for a new code holds a code without holding the user's row first, and it is ending that code itself.
 * To wait for it could be to wait for ever: it goes on to store the new code, which refers to the user's row, and
 * that waits for this change when the change sets a new e-mail address as well. A deadlock, and one of the two
 * requests would fail.
 */
export const withdrawCodeUnlessHeld = async (db: DatabaseOrTransaction, { userId, purpose }: { userId: string; purpose: Purpose }, now = new Date()) => {
  const open = db
    .select({ id: otpCodes.id })
    .from(otpCodes)
    .where(and(eq(otpCodes.userId, userId), eq(otpCodes.purpose, purpose), isNull(otpCodes.consumedAt), gt(otpCodes.expiresAt, now)))
    .for('no key update', { skipLocked: true })
  await db.update(otpCodes).set({ expiresAt: now }).where(inArray(otpCodes.id, open))
}

export type CodeCheck =
  | { ok: true; channel: Channel }
  | { ok: false; reason: 'wrong' | 'expired' | 'exhausted' | 'none' }

/**
 * Checks a code. Every check counts as an attempt, the right one included, and is counted before
 * comparing, so parallel guesses cannot get more tries than allowed. After five attempts the code is
 * dead: the sixth is refused even when it is right. A right code works once. A code that was issued with
 * `boundTo` is right only together with the same value.
 */
export const checkCode = async (
  db: DatabaseOrTransaction,
  { userId, purpose, code, boundTo }: { userId: string; purpose: Purpose; code: string; boundTo?: string },
  { secrets, now = new Date() }: CodeOptions,
): Promise<CodeCheck> => {
  const [current] = await db
    .select()
    .from(otpCodes)
    .where(and(eq(otpCodes.userId, userId), eq(otpCodes.purpose, purpose), isNull(otpCodes.consumedAt)))
    .orderBy(sql`${otpCodes.createdAt} desc`)
    .limit(1)
  if (!current) return { ok: false, reason: 'none' }
  if (current.expiresAt <= now) return { ok: false, reason: 'expired' }

  const [attempt] = await db
    .update(otpCodes)
    .set({ attempts: sql`${otpCodes.attempts} + 1` })
    .where(and(eq(otpCodes.id, current.id), isNull(otpCodes.consumedAt), sql`${otpCodes.attempts} < ${MAX_ATTEMPTS}`))
    .returning({ attempts: otpCodes.attempts })
  if (!attempt) return { ok: false, reason: 'exhausted' }

  const matches = secrets.some((secret) => sameHash(sign(secret, userId, purpose, code.trim(), boundTo), current.codeHash))
  if (!matches) return { ok: false, reason: 'wrong' }

  const [used] = await db
    .update(otpCodes)
    .set({ consumedAt: now })
    .where(and(eq(otpCodes.id, current.id), isNull(otpCodes.consumedAt)))
    .returning({ id: otpCodes.id })
  return used ? { ok: true, channel: current.channel } : { ok: false, reason: 'none' }
}

/**
 * The code that is currently valid for the user and purpose, if any: through which channel it went, until when,
 * and whether it can still be entered (`usable` is false once its attempts are used up).
 */
export const currentCode = async (
  db: DatabaseOrTransaction,
  { userId, purpose }: { userId: string; purpose: Purpose },
  now = new Date(),
) => {
  const [code] = await db
    .select({ channel: otpCodes.channel, expiresAt: otpCodes.expiresAt, usable: sql<boolean>`${otpCodes.attempts} < ${MAX_ATTEMPTS}` })
    .from(otpCodes)
    .where(and(eq(otpCodes.userId, userId), eq(otpCodes.purpose, purpose), isNull(otpCodes.consumedAt), gt(otpCodes.expiresAt, now)))
    .orderBy(sql`${otpCodes.createdAt} desc`)
    .limit(1)
  return code
}

/** Records that the current code went out by another channel, e.g. because the SMS could not be sent. */
export const changeCodeChannel = async (
  db: Database,
  { userId, purpose, channel }: { userId: string; purpose: Purpose; channel: Channel },
  now = new Date(),
) => {
  await db
    .update(otpCodes)
    .set({ channel })
    .where(and(eq(otpCodes.userId, userId), eq(otpCodes.purpose, purpose), isNull(otpCodes.consumedAt), gt(otpCodes.expiresAt, now)))
}

/** Marks the e-mail address as confirmed. Keeps the first time if it was confirmed before. */
export const markEmailVerified = async (db: Database, userId: string, now = new Date()) => {
  await db
    .update(users)
    .set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, ${now.toISOString()}::timestamptz)` })
    .where(eq(users.id, userId))
}

/** Deletes codes that can no longer be used. Returns how many. */
export const deleteOldCodes = async (db: Database, now = new Date()) => {
  const deleted = await db
    .delete(otpCodes)
    .where(sql`${otpCodes.expiresAt} < ${new Date(now.getTime() - 60 * 60 * 1000).toISOString()}::timestamptz`)
    .returning({ id: otpCodes.id })
  return deleted.length
}
