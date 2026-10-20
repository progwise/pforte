import formbody from '@fastify/formbody'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ACR_SECOND_FACTOR } from '../auth/assurance.js'
import { parseAcceptLanguage } from '../i18n/index.js'
import type { MessageKey, Values } from '../i18n/index.js'
import { readCookie, setCookieHeader, sign, unsign } from '../interaction/signed-cookie.js'
import { refuseForeignPosts } from '../security/origin-check.js'
import { escapeHtml } from '../ui/pages.js'
import type { Ui } from '../ui/index.js'
import { createApiCaller } from './api.js'
import { ADMIN_UI_CLIENT_ID, MANAGE_PATH } from './constants.js'
import { challengeOf, isForThisSignIn, type LoginState, newLogin, readIdToken, safeNext } from './oidc.js'

export interface ManageDependencies {
  /** The public address of pforte. */
  issuer: string
  /** Sign the cookies of the UI. */
  cookieKeys: string[]
  ui: Ui
  /** Named on the start page. */
  organisation: string
}

/** The session of a person in the UI: kept in a signed cookie, so there is nothing to store on the server. */
export interface ManageSession {
  token: string
  /** Kept to tell pforte who is signing out. */
  idToken: string
  user: { id: string; name: string; language: string }
  expiresAt: number
}

const SESSION_COOKIE = 'pforte_manage'
const LOGIN_COOKIE = 'pforte_manage_login'
const MAX_SESSION_SECONDS = 8 * 60 * 60

/**
 * The administration UI: server-rendered pages under `/manage` for the people who run pforte. A person signs in
 * the way anybody does, with the second factor always required, and everything the pages do goes through the admin API
 * with that person's own token.
 */
export const manageRoutes =
  ({ issuer, cookieKeys, ui, organisation }: ManageDependencies) =>
  async (app: FastifyInstance) => {
    await app.register(formbody)
    ui.pages.addHeaders(app)

    const secure = issuer.startsWith('https:')
    const redirectUri = `${issuer}${MANAGE_PATH}/callback`
    const callApi = createApiCaller(app)

    const acceptedLanguages = (request: FastifyRequest) => parseAcceptLanguage(request.headers['accept-language'])
    const languageOf = (request: FastifyRequest, session?: ManageSession) => ui.i18n.pick(session?.user.language, acceptedLanguages(request))
    const viewFor = (request: FastifyRequest, session?: ManageSession) => {
      const view = ui.pages.for(languageOf(request, session))
      return { view, t: (key: MessageKey, values?: Values) => view.t(key, values) }
    }

    app.addHook(
      'onRequest',
      refuseForeignPosts(issuer, (request, reply) => {
        const { view } = viewFor(request)
        return reply.code(403).type('text/html').send(view.notice(view.t('error.refusedTitle'), view.t('error.refused')))
      }),
    )

    const cookie = (name: string, value: string, maxAgeSeconds: number) =>
      setCookieHeader(name, value, { path: MANAGE_PATH, maxAgeSeconds, secure })

    const sessionOf = (request: FastifyRequest) => {
      const session = unsign<ManageSession>(cookieKeys, readCookie(request.headers.cookie, SESSION_COOKIE))
      return session && session.expiresAt > Date.now() ? session : undefined
    }

    /** The session, or the person is sent to sign in and brought back to where they were going. */
    const requireSession = (request: FastifyRequest, reply: FastifyReply) => {
      const session = sessionOf(request)
      if (!session) {
        const next = request.method === 'GET' ? `?next=${encodeURIComponent(request.url)}` : ''
        void reply.redirect(`${MANAGE_PATH}/login${next}`, 303)
      }
      return session
    }

    /** The sections the person can open. */
    const sections = (t: (key: MessageKey) => string, current: string) => [
      { href: MANAGE_PATH, label: t('manage.nav.home'), current: current === 'home' },
    ]

    /** A page of the administration for a person who is signed in. */
    const page = (request: FastifyRequest, session: ManageSession, current: string, title: string, content: string) => {
      const { view, t } = viewFor(request, session)
      return view.manage({
        title,
        sectionsLabel: t('manage.nav.label'),
        nav: sections(t, current),
        person: { signedInAs: t('manage.signedInAs', { name: session.user.name }), signOutLabel: t('manage.signOut') },
        content,
      })
    }

    /** A page for somebody who has no session: what the sign-in or the sign-out came to. */
    const publicPage = (request: FastifyRequest, titleKey: MessageKey, textKey: MessageKey, values?: Values, withSignIn = true) => {
      const { view, t } = viewFor(request)
      return view.notice(t(titleKey), t(textKey, values), withSignIn ? { href: `${MANAGE_PATH}/login`, label: t('manage.signIn') } : undefined)
    }

    // --- Signing in: pforte's own login, as any application, and always with the second factor

    const beginLogin = (request: FastifyRequest, reply: FastifyReply, next: string, forced: boolean) => {
      const login = newLogin(next, forced)
      const parameters = new URLSearchParams({
        client_id: ADMIN_UI_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid profile',
        state: login.state,
        nonce: login.nonce,
        code_challenge: challengeOf(login.verifier),
        code_challenge_method: 'S256',
        acr_values: ACR_SECOND_FACTOR,
        ...(forced ? { prompt: 'login' } : {}),
      })
      const languages = acceptedLanguages(request).slice(0, 3).join(' ')
      if (languages) parameters.set('ui_locales', languages)
      reply.header('Set-Cookie', cookie(LOGIN_COOKIE, sign(cookieKeys, login), 600))
      return reply.redirect(`${issuer}/auth?${parameters}`, 303)
    }

    app.get<{ Querystring: { next?: string } }>(`${MANAGE_PATH}/login`, async (request, reply) =>
      beginLogin(request, reply, safeNext(request.query.next, MANAGE_PATH), false),
    )

    const failed = (request: FastifyRequest, reply: FastifyReply, status = 400) =>
      reply.code(status).type('text/html').header('Set-Cookie', cookie(LOGIN_COOKIE, '', 0)).send(publicPage(request, 'manage.loginFailed.title', 'manage.loginFailed.text'))

    app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(`${MANAGE_PATH}/callback`, async (request, reply) => {
      const login = unsign<LoginState>(cookieKeys, readCookie(request.headers.cookie, LOGIN_COOKIE))
      const { code, state, error } = request.query
      if (!login || login.expiresAt < Date.now() || typeof state !== 'string' || state !== login.state) return failed(request, reply)
      if (error || typeof code !== 'string') return failed(request, reply)

      const exchange = await app.inject({
        method: 'POST',
        url: '/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: ADMIN_UI_CLIENT_ID,
          code_verifier: login.verifier,
        }).toString(),
        remoteAddress: request.ip,
      })
      if (exchange.statusCode !== 200) return failed(request, reply)
      const tokens = exchange.json() as { access_token?: string; id_token?: string; expires_in?: number }

      const claims = readIdToken(tokens.id_token)
      if (!tokens.access_token || !tokens.id_token || !claims || !isForThisSignIn(claims, { issuer, clientId: ADMIN_UI_CLIENT_ID, nonce: login.nonce })) {
        return failed(request, reply)
      }

      // The library treats `acr_values` as a wish: a single sign-on session that was started without a code is
      // returned as it is. The administration insists, so it asks again, this time for a new sign-in.
      if (claims.acr !== ACR_SECOND_FACTOR) {
        if (login.forced) return failed(request, reply, 403)
        return beginLogin(request, reply, login.next, true)
      }

      const who = await callApi(request, tokens.access_token, { method: 'GET', url: '/whoami' })
      if (who.statusCode === 401) {
        return reply
          .code(403)
          .type('text/html')
          .header('Set-Cookie', cookie(LOGIN_COOKIE, '', 0))
          .send(publicPage(request, 'manage.notAdmin.title', 'manage.notAdmin.text', { name: claims.name ?? claims.email ?? '' }, false))
      }
      if (who.statusCode !== 200) return failed(request, reply, 502)
      const person = who.json().user as { id: string; email: string; firstName: string; lastName: string; language: string }

      const lifetime = Math.min(tokens.expires_in ?? 3600, MAX_SESSION_SECONDS)
      const session: ManageSession = {
        token: tokens.access_token,
        idToken: tokens.id_token,
        user: { id: person.id, name: `${person.firstName} ${person.lastName}`.trim() || person.email, language: person.language },
        expiresAt: Date.now() + lifetime * 1000,
      }
      reply.header('Set-Cookie', [cookie(SESSION_COOKIE, sign(cookieKeys, session), lifetime), cookie(LOGIN_COOKIE, '', 0)])
      return reply.redirect(login.next, 303)
    })

    // --- Signing out ends pforte's own session too: on a shared computer the next person must not walk in

    app.post(`${MANAGE_PATH}/logout`, async (request, reply) => {
      const session = sessionOf(request)
      reply.header('Set-Cookie', cookie(SESSION_COOKIE, '', 0))
      if (!session) return reply.redirect(`${MANAGE_PATH}/signed-out`, 303)
      const parameters = new URLSearchParams({
        id_token_hint: session.idToken,
        post_logout_redirect_uri: `${issuer}${MANAGE_PATH}/signed-out`,
      })
      return reply.redirect(`${issuer}/session/end?${parameters}`, 303)
    })

    app.get(`${MANAGE_PATH}/signed-out`, async (request, reply) =>
      reply.type('text/html').header('Set-Cookie', cookie(SESSION_COOKIE, '', 0)).send(publicPage(request, 'manage.signedOut.title', 'manage.signedOut.text')),
    )

    // --- Start page

    app.get(MANAGE_PATH, async (request, reply) => {
      const session = requireSession(request, reply)
      if (!session) return reply
      const { t } = viewFor(request, session)
      return reply
        .type('text/html')
        .send(
          page(
            request,
            session,
            'home',
            t('manage.home.title'),
            `<h1>${escapeHtml(t('manage.home.title'))}</h1>\n<div class="panel"><p>${escapeHtml(t('manage.home.intro', { organisation }))}</p></div>`,
          ),
        )
    })
  }
