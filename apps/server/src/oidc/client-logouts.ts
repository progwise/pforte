import type { Database } from '@progwise/pforte-db'
import { type ClientLogout, recordAuditEvent } from '@progwise/pforte-db/admin'
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
  /** Hears of an application that could not be told, after the last attempt. */
  onFailure?: (failure: { clientId: string; reason: string; attempts: number }) => void
}

/** At once, after two seconds and after ten: an application that restarts gets a second chance, one that is down does not hold anything up. */
const PAUSES_MS = [2_000, 8_000]

/** The library's client, with the method its own sign-out uses. Not in its type declarations. */
interface LogoutCapableClient {
  backchannelLogoutUri?: string
  backchannelLogout(sub: string, sid?: string): Promise<void>
}

/**
 * Why a call failed, in a word for the audit log: the status the application answered with, that it did not
 * answer in time, that its address is a private one pforte refuses to call, or that it could not be reached.
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
      if (!client?.backchannelLogoutUri) return undefined
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
