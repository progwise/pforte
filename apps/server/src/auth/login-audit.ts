import type { Database } from '@progwise/pforte-db'
import { recordAuditEvent } from '@progwise/pforte-db/admin'
import { consume } from '@progwise/pforte-db/rate-limits'
import { findUserByEmail } from '@progwise/pforte-db/users'
import { hashAddress } from './address-hash.js'
import type { AuthFailure } from './authenticate.js'

/** Where a sign-in attempt came from. */
export interface Origin {
  ip?: string
  userAgent?: string
}

export type CodePurpose = 'login' | 'password_reset' | 'activation'

/** What the audit log is told about attempts to sign in. See docs/audit-log.md. */
export interface LoginAudit {
  passwordFailed(origin: Origin, attempt: { email: string; reason: AuthFailure; userId?: string }): Promise<void>
  /** Something was refused because of a rate limit. Recorded once per window and subject, not for every refused request. */
  blocked(origin: Origin, attempt: { scope: string; email?: string }): Promise<void>
  codeSent(origin: Origin, sent: { userId: string; purpose: CodePurpose; channel: 'email' | 'sms'; fellBack?: boolean }): Promise<void>
  codeFailed(origin: Origin, failure: { userId?: string; email?: string; purpose: CodePurpose; reason: string }): Promise<void>
  succeeded(origin: Origin, success: { userId: string; method: 'code' | 'remembered_device'; channel?: 'email' | 'sms'; acr: string }): Promise<void>
  resetRequested(origin: Origin, request: { userId: string }): Promise<void>
}

export interface LoginAuditOptions {
  db: Database
  /** Keys the hash that stands for an address that no user has. */
  secret: string
  /** Where a failure to write is reported; it never stops a sign-in. */
  onError?: (error: unknown) => void
}

const BLOCK_WINDOW_SECONDS = 15 * 60

export const createLoginAudit = ({ db, secret, onError = () => {} }: LoginAuditOptions): LoginAudit => {
  /** Writes an event. A sign-in must not fail because its log entry could not be written, so this only reports. */
  const record = async (origin: Origin, event: { actor?: { type: 'user'; id?: string }; action: string; userId?: string; details: Record<string, unknown> }) => {
    try {
      await recordAuditEvent(db, {
        actor: event.actor ?? { type: 'user', id: event.userId },
        ip: origin.ip,
        userAgent: origin.userAgent,
        action: event.action,
        target: event.userId ? { type: 'user', id: event.userId } : undefined,
        details: event.details,
      })
    } catch (error) {
      onError(error)
    }
  }

  // An address nobody has is not stored: people type passwords into the e-mail field. Only a hash, which
  // still shows that the same address was tried again and again.
  const unknownAddress = (email: string) => ({ emailHash: hashAddress(secret, 'audit', email, 16) })

  return {
    passwordFailed: (origin, { email, reason, userId }) =>
      record(origin, { action: 'login.password_failed', userId, details: { reason, ...(userId ? {} : unknownAddress(email)) } }),

    async blocked(origin, { scope, email }) {
      try {
        const subject = email ? hashAddress(secret, 'audit', email, 16) : (origin.ip ?? 'unknown')
        // The first refusal in a window is recorded, the rest are not: an attacker must not be able to fill the log.
        const wait = await consume(db, { key: `audit-blocked:${scope}:${subject}`, max: 1, windowSeconds: BLOCK_WINDOW_SECONDS })
        if (wait > 0) return
        const user = email ? await findUserByEmail(db, email) : undefined
        await record(origin, { action: 'login.blocked', userId: user?.id, details: { scope, ...(email && !user ? unknownAddress(email) : {}) } })
      } catch (error) {
        onError(error)
      }
    },

    codeSent: (origin, { userId, purpose, channel, fellBack }) =>
      record(origin, { action: 'login.code_sent', userId, details: { purpose, channel, ...(fellBack ? { fellBackToEmail: true } : {}) } }),

    codeFailed: (origin, { userId, email, purpose, reason }) =>
      record(origin, { action: 'login.code_failed', userId, details: { purpose, reason, ...(!userId && email ? unknownAddress(email) : {}) } }),

    succeeded: (origin, { userId, method, channel, acr }) =>
      record(origin, { action: 'login.succeeded', userId, details: { method, ...(channel ? { channel } : {}), acr } }),

    resetRequested: (origin, { userId }) => record(origin, { action: 'user.password_reset.request', userId, details: { self: true } }),
  }
}
