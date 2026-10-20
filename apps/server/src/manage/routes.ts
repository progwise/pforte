import formbody from '@fastify/formbody'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ACR_SECOND_FACTOR } from '../auth/assurance.js'
import type { MessageKey, Values } from '../i18n/index.js'
import { readCookie, sign, unsign } from '../interaction/signed-cookie.js'
import { refuseForeignPosts } from '../security/origin-check.js'
import { escapeHtml } from '../ui/pages.js'
import { ADMIN_UI_CLIENT_ID, MANAGE_PATH } from './constants.js'
import { createManageContext, type ManageDependencies, type ManageSession, SESSION_COOKIE } from './context.js'
import { registerUsers } from './users.js'
import { challengeOf, isForThisSignIn, type LoginState, newLogin, readIdToken, safeNext } from './oidc.js'

const LOGIN_COOKIE = 'pforte_manage_login'
const MAX_SESSION_SECONDS = 8 * 60 * 60

/**
 * The administration UI: server-rendered pages under `/manage` for the people who run pforte. A person signs in
 * the way anybody does, with the second factor always required, and everything the pages do goes through the admin API
 * with that person's own token.
 */
export const manageRoutes =
  (dependencies: ManageDependencies) =>
  async (app: FastifyInstance) => {
    const { issuer, cookieKeys, ui, organisation } = dependencies
    await app.register(formbody)
    ui.pages.addHeaders(app)

    const ctx = createManageContext(app, dependencies)
    const { acceptedLanguages, viewFor, cookie, sessionOf, requireSession, page } = ctx
    const redirectUri = `${issuer}${MANAGE_PATH}/callback`
    const callApi = ctx.callApi

    app.addHook(
      'onRequest',
      refuseForeignPosts(issuer, (request, reply) => {
        const { view } = viewFor(request)
        return reply.code(403).type('text/html').send(view.notice(view.t('error.refusedTitle'), view.t('error.refused')))
      }),
    )

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
            reply,
            session,
            'home',
            t('manage.home.title'),
            `<h1>${escapeHtml(t('manage.home.title'))}</h1>\n<div class="panel"><p>${escapeHtml(t('manage.home.intro', { organisation }))}</p></div>`,
          ),
        )
    })

    registerUsers(app, ctx)
  }
