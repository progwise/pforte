import type { Database } from '@progwise/pforte-db'
import { isSignedInTo } from '@progwise/pforte-db/admin'
import { findActiveUserById } from '@progwise/pforte-db/oidc'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { readCookie, setCookieHeader, sign, unsign } from '../interaction/signed-cookie.js'
import { ACCOUNT_PATH, ACCOUNT_UI_CLIENT_ID } from './constants.js'

/**
 * The session of a person on the account pages, kept in a signed cookie. It holds no token: the pages call no
 * API, they read and change the person in the database, and only this person.
 */
export interface AccountSession {
  userId: string
  /** The assurance of the sign-in; always the one with a code, or there would be no session. */
  acr: string
  /** When the person last signed in at pforte, in seconds: a change asks for a recent one. */
  authTime: number
  expiresAt: number
}

export const ACCOUNT_COOKIE = 'pforte_account'
/** After an hour the person goes through the sign-in again, which is silent while pforte's own session lasts. */
export const ACCOUNT_SESSION_SECONDS = 60 * 60

export type AccountUser = NonNullable<Awaited<ReturnType<typeof findActiveUserById>>>

export const createAccountGate = ({ db, cookieKeys, secure }: { db: Database; cookieKeys: string[]; secure: boolean }) => {
  // Lax, not Strict as pforte's other cookies: people come here by a link from their application, and a browser
  // does not send a Strict cookie along with such a click, nor with the redirects that follow it.
  const cookie = (value: string, maxAgeSeconds: number) => setCookieHeader(ACCOUNT_COOKIE, value, { path: ACCOUNT_PATH, maxAgeSeconds, secure, sameSite: 'Lax' })

  const sessionOf = (request: FastifyRequest) => {
    const session = unsign<AccountSession>(cookieKeys, readCookie(request.headers.cookie, ACCOUNT_COOKIE))
    return session && session.expiresAt > Date.now() ? session : undefined
  }

  /**
   * The person whose account this request is about, or undefined after sending the browser to sign in.
   *
   * This is the only place the account pages learn who somebody is. No handler reads a user from the address, a
   * form or a header, and no address of the area carries one, so there is nothing to change into somebody else's.
   *
   * The cookie alone is not enough. The person must still be active, and still be signed in to the account pages
   * at pforte: locking them, signing them out everywhere or a new password ends that, and with it every copy of
   * this cookie, also one that was stolen.
   */
  const requireAccountSession = async (request: FastifyRequest, reply: FastifyReply): Promise<{ session: AccountSession; user: AccountUser } | undefined> => {
    const session = sessionOf(request)
    const user = session ? await findActiveUserById(db, session.userId) : undefined
    if (session && user && (await isSignedInTo(db, user.id, ACCOUNT_UI_CLIENT_ID))) return { session, user }

    reply.header('Set-Cookie', cookie('', 0))
    // Only a page can be come back to; what a form was about to do is not repeated behind the person's back.
    const next = request.method === 'GET' ? `?next=${encodeURIComponent(request.url)}` : ''
    void reply.redirect(`${ACCOUNT_PATH}/login${next}`, 303)
    return undefined
  }

  return {
    requireAccountSession,
    /** The cookie for a sign-in that was just completed. */
    start: (session: Omit<AccountSession, 'expiresAt'>) => cookie(sign(cookieKeys, { ...session, expiresAt: Date.now() + ACCOUNT_SESSION_SECONDS * 1000 } satisfies AccountSession), ACCOUNT_SESSION_SECONDS),
    /** The header that removes the cookie. */
    end: () => cookie('', 0),
    /** Whether the browser shows a session at all, checked or not: for the sign-out, which needs nothing more. */
    hasCookie: (request: FastifyRequest) => sessionOf(request) !== undefined,
  }
}

export type AccountGate = ReturnType<typeof createAccountGate>
