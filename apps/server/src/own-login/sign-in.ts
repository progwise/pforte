import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ACR_SECOND_FACTOR } from '../auth/assurance.js'
import { readCookie, setCookieHeader, sign, unsign } from '../interaction/signed-cookie.js'
import { challengeOf, type IdTokenClaims, isForThisSignIn, type LoginState, newLogin, readIdToken } from './oidc.js'

export interface OwnSignInOptions {
  /** The public address of pforte. */
  issuer: string
  cookieKeys: string[]
  /** The built-in client of the area. */
  clientId: string
  /** Where the area lives, such as `/manage`. Its callback is `<basePath>/callback`, and its cookies are limited to it. */
  basePath: string
  /** The cookie that carries a sign-in from leaving for the login page to coming back. */
  loginCookie: string
  scope: string
  /** For the login cookie; see `CookieOptions.sameSite`. */
  sameSite?: 'Strict' | 'Lax'
  /** The languages the browser asks for, passed on so the login page speaks the same one. */
  acceptedLanguages: (request: FastifyRequest) => string[]
}

/** What coming back from the login page led to. */
export type SignInOutcome =
  | {
      kind: 'signed-in'
      claims: IdTokenClaims
      accessToken: string
      idToken: string
      /** How long the access token lasts, in seconds, if the answer said so. */
      expiresIn?: number
      /** Where the person was going. */
      next: string
    }
  /** The answer was a redirect to sign in again, with a code this time. Nothing more to do. */
  | { kind: 'redirected' }
  /** Not a sign-in of this browser, or one that went wrong. The caller shows its page with this status. */
  | { kind: 'failed'; status: number }

/**
 * How one of pforte's own areas (the administration, the account pages) signs a person in: as any application
 * does, with the authorization code flow and PKCE against pforte itself, and always asking for the second factor.
 * The area decides what a sign-in is worth to it and keeps its own session; this is only the way there and back.
 */
export const createOwnSignIn = (app: FastifyInstance, { issuer, cookieKeys, clientId, basePath, loginCookie, scope, sameSite, acceptedLanguages }: OwnSignInOptions) => {
  const secure = issuer.startsWith('https:')
  const redirectUri = `${issuer}${basePath}/callback`
  const cookie = (value: string, maxAgeSeconds: number) => setCookieHeader(loginCookie, value, { path: basePath, maxAgeSeconds, secure, sameSite })

  /** Sends the browser to pforte's login page. `forced` asks for a new sign-in even if the browser has a session. */
  const begin = (request: FastifyRequest, reply: FastifyReply, next: string, forced = false) => {
    const login = newLogin(next, forced)
    const parameters = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope,
      state: login.state,
      nonce: login.nonce,
      code_challenge: challengeOf(login.verifier),
      code_challenge_method: 'S256',
      acr_values: ACR_SECOND_FACTOR,
      ...(forced ? { prompt: 'login' } : {}),
    })
    const languages = acceptedLanguages(request).slice(0, 3).join(' ')
    if (languages) parameters.set('ui_locales', languages)
    reply.header('Set-Cookie', cookie(sign(cookieKeys, login), 600))
    return reply.redirect(`${issuer}/auth?${parameters}`, 303)
  }

  /**
   * The callback: checks that the answer belongs to a sign-in this browser started, exchanges the code and reads
   * the ID token. A sign-in without the second factor is not accepted: the browser is sent back once, for a new one.
   */
  const finish = async (request: FastifyRequest<{ Querystring: { code?: string; state?: string; error?: string } }>, reply: FastifyReply): Promise<SignInOutcome> => {
    const login = unsign<LoginState>(cookieKeys, readCookie(request.headers.cookie, loginCookie))
    const { code, state, error } = request.query
    if (!login || login.expiresAt < Date.now() || typeof state !== 'string' || state !== login.state) return { kind: 'failed', status: 400 }
    if (error || typeof code !== 'string') return { kind: 'failed', status: 400 }

    const exchange = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: login.verifier }).toString(),
      remoteAddress: request.ip,
    })
    if (exchange.statusCode !== 200) return { kind: 'failed', status: 400 }
    const tokens = exchange.json() as { access_token?: string; id_token?: string; expires_in?: number }

    const claims = readIdToken(tokens.id_token)
    if (!tokens.access_token || !tokens.id_token || !claims || !isForThisSignIn(claims, { issuer, clientId, nonce: login.nonce })) {
      return { kind: 'failed', status: 400 }
    }

    // The library treats `acr_values` as a wish: a single sign-on session that was started without a code is
    // returned as it is. pforte's own areas insist, so they ask again, this time for a new sign-in.
    if (claims.acr !== ACR_SECOND_FACTOR) {
      if (login.forced) return { kind: 'failed', status: 403 }
      begin(request, reply, login.next, true)
      return { kind: 'redirected' }
    }

    return { kind: 'signed-in', claims, accessToken: tokens.access_token, idToken: tokens.id_token, expiresIn: tokens.expires_in, next: login.next }
  }

  return {
    begin,
    finish,
    /** The header that removes the login cookie, for the answer that ends a sign-in either way. */
    clearCookie: () => cookie('', 0),
  }
}

export type OwnSignIn = ReturnType<typeof createOwnSignIn>
