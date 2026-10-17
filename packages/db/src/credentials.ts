import { and, eq, gt, sql } from 'drizzle-orm'
import { activationTokenHash, endUserSessions } from './admin/lifecycle.js'
import { recordAuditEvent } from './audit.js'
import type { Database } from './index.js'
import { users } from './schema/index.js'

interface Origin {
  ip?: string
  userAgent?: string
}

/** The user an activation link belongs to, if the link is still valid: not used, not expired, user not yet active. */
export const findPendingActivation = async (db: Database, token: string, now = new Date()) => {
  const [user] = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.activationTokenHash, activationTokenHash(token)),
        eq(users.status, 'created'),
        gt(users.activationExpiresAt, now),
      ),
    )
  return user
}

/**
 * Sets the first password and activates the user. The link works once: the token is cleared in the same
 * statement that checks it, so two requests cannot both succeed. Opening the link proves the mailbox,
 * so the e-mail address counts as verified. Returns undefined if the link is not valid (any more).
 */
export const completeActivation = (
  db: Database,
  { token, passwordHash, ip, userAgent }: { token: string; passwordHash: string } & Origin,
  now = new Date(),
) =>
  db.transaction(async (tx) => {
    const [user] = await tx
      .update(users)
      .set({
        passwordHash,
        status: 'active',
        activationTokenHash: null,
        activationExpiresAt: null,
        emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, ${now.toISOString()}::timestamptz)`,
        failedLoginAttempts: 0,
      })
      .where(
        and(
          eq(users.activationTokenHash, activationTokenHash(token)),
          eq(users.status, 'created'),
          gt(users.activationExpiresAt, now),
        ),
      )
      .returning()
    if (!user) return undefined
    await recordAuditEvent(tx, {
      actor: { type: 'user', id: user.id },
      ip,
      userAgent,
      action: 'user.activate.complete',
      target: { type: 'user', id: user.id },
      details: { email: user.email },
    })
    return user
  })

/**
 * Sets a new password after the user proved who they are with a code. All sessions, tokens and
 * remembered devices end: whoever knew the old password, or had a session, must start again.
 * Returns false if the user cannot sign in (any more).
 */
export const completePasswordReset = (db: Database, { userId, passwordHash, ip, userAgent }: { userId: string; passwordHash: string } & Origin) =>
  db.transaction(async (tx) => {
    const [user] = await tx
      .update(users)
      .set({ passwordHash, failedLoginAttempts: 0 })
      .where(and(eq(users.id, userId), eq(users.status, 'active')))
      .returning()
    if (!user) return false
    const ended = await endUserSessions(tx, user.id)
    await recordAuditEvent(tx, {
      actor: { type: 'user', id: user.id },
      ip,
      userAgent,
      action: 'user.password_reset.complete',
      target: { type: 'user', id: user.id },
      details: { email: user.email, ...ended },
    })
    return true
  })
