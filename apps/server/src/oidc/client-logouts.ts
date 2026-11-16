import type { Database } from '@progwise/pforte-db'
import { type ClientLogout, isSignedInTo, recordAuditEvent } from '@progwise/pforte-db/admin'
import type { Background } from '../security/background.js'
import type { ProviderHolder } from './provider.js'

/**
 * Tells applications that the sessions of a user were ended by somebody other than the user in their browser:
 * an administrator locked, deactivated or deleted them, ended their sessions or started a password reset, or
 * the user completed one. Each application with a back-channel logout address gets the same logout token it gets
 * when the user signs out at pforte.
 */
export interface ClientLogouts {
  /**
   * Starts sending and returns at once. Call it after the change is committed: what is sent cannot be taken back.
   * It never throws and never waits, so the action that ended the sessions neither fails nor slows down because
   * an application is unreachable.
   */
  send(user: { id: string; email: string }, logouts: ClientLogout[]): void
}

export interface ClientLogoutsOptions {
  db: Database
  provider: Pick<ProviderHolder, 'current'>
  /** Carries the calls, so they go on after the response and are finished before the server stops. */
  background: Background
  /** How long to wait before the second, third, … attempt. One attempt more than there are pauses. */
  pausesMs?: number[]
  /** Hears of an application that could not be told, when pforte stops trying. */
  onFailure?: (failure: { clientId: string; reason: string; attempts: number }) => void
}

/** At once, after two seconds and after ten: an application that restarts gets a second chance, one that is down does not hold anything up. */
const PAUSES_MS = [2_000, 8_000]

/** The library's client, with the method its own sign-out uses. Not in its type declarations. */
interface LogoutCapableClient {
  backchannelLogoutUri?: string
  /** Whether the token it builds carries the session ID it is given. Without it the ID is dropped. */
  backchannelLogoutSessionRequired?: boolean
  backchannelLogout(sub: string, sid?: string): Promise<void>
}

/**
 * Why a call failed, in a word for the audit log: the status the application answered with, that it did not
 * answer in time, that its address is a private one pforte refuses to call, or that it could not be reached.
 * Two more reasons, `signed_in_again` and `address_removed`, are not failed calls but calls that were not made
 * any more after a failed one; see `deliver`.
 */
export const failureReason = (error: unknown) => {
  const status = (error as { response?: { status?: unknown } } | undefined)?.response?.status
  if (typeof status === 'number') return `http_${status}`
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout'
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    if (cause.message.includes('special-use IP address')) return 'private_address'
  }
  return 'unreachable'
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const createClientLogouts = ({ db, provider, background, pausesMs = PAUSES_MS, onFailure }: ClientLogoutsOptions): ClientLogouts => {
  const attempts = pausesMs.length + 1

  /** Sends one logout token, trying again after a failure. Returns why it failed in the end, or undefined. */
  const deliver = async (userId: string, { clientId, sid }: ClientLogout) => {
    let reason = 'unreachable'
    for (let attempt = 1; attempt <= attempts; attempt++) {
      // Looked up for every attempt: the address may have been corrected, or the client deleted, in the meantime.
      const client = (await provider.current().Client.find(clientId)) as LogoutCapableClient | undefined
      // Gone before the first attempt: nothing was owed any more. Gone after a failed one: the application was not told.
      if (!client?.backchannelLogoutUri) return attempt > 1 ? { reason: 'address_removed', attempts: attempt - 1 } : undefined
      // A logout without a session ID means "all sessions of this person", and every attempt sends a new token,
      // dated now. Somebody who was signed out everywhere, or reset their password, may have signed in again
      // while this waited: the late token would end that new session too. So it is not sent any more.
      // Whether the token names a session is decided by the client as it is now, not as it was when the logout
      // was queued: the library drops the ID for a client that no longer asks for it.
      const namesSession = Boolean(sid) && client.backchannelLogoutSessionRequired === true
      if (attempt > 1 && !namesSession && (await isSignedInTo(db, userId, clientId))) return { reason: 'signed_in_again', attempts: attempt - 1 }
      try {
        await client.backchannelLogout(userId, sid)
        return undefined
      } catch (error) {
        reason = failureReason(error)
        // Asking again does not make a private address a public one.
        if (reason === 'private_address') return { reason, attempts: attempt }
      }
      if (attempt < attempts) await pause(pausesMs[attempt - 1]!)
    }
    return { reason, attempts }
  }

  return {
    send(user, logouts) {
      for (const logout of logouts) {
        background.run(async () => {
          const failure = await deliver(user.id, logout)
          if (!failure) return
          onFailure?.({ clientId: logout.clientId, ...failure })
          // The event of the action said how many applications were to be told; this says which one was not.
          // It is written when pforte stops trying. A restart before that loses the attempt and the event alike,
          // so a missing event does not prove that the application answered.
          await recordAuditEvent(db, {
            actor: { type: 'system' },
            action: 'user.sessions.notify_failed',
            target: { type: 'user', id: user.id },
            details: { email: user.email, clientId: logout.clientId, ...failure },
          })
        })
      }
    },
  }
}
