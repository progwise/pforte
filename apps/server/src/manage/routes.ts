import formbody from '@fastify/formbody'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { MessageKey, Values } from '../i18n/index.js'
import { sign } from '../interaction/signed-cookie.js'
import { safeNext } from '../own-login/oidc.js'
import { createOwnSignIn } from '../own-login/sign-in.js'
import { refuseForeignPosts } from '../security/origin-check.js'
import { escapeHtml } from '../ui/pages.js'
import { ADMIN_UI_CLIENT_ID, MANAGE_PATH } from './constants.js'
import { createManageContext, type ManageDependencies, type ManageSession, SESSION_COOKIE } from './context.js'
import { registerAudit } from './audit.js'
import { registerClaimTypes } from './claim-types.js'
import { registerClients } from './clients.js'
import { registerImport } from './import.js'
import { registerUsers } from './users.js'

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

    const signIn = createOwnSignIn(app, { issuer, cookieKeys, clientId: ADMIN_UI_CLIENT_ID, basePath: MANAGE_PATH, loginCookie: LOGIN_COOKIE, scope: 'openid profile', acceptedLanguages })

    app.get<{ Querystring: { next?: string } }>(`${MANAGE_PATH}/login`, async (request, reply) => signIn.begin(request, reply, safeNext(request.query.next, MANAGE_PATH)))

    const failed = (request: FastifyRequest, reply: FastifyReply, status = 400) =>
      reply.code(status).type('text/html').header('Set-Cookie', signIn.clearCookie()).send(publicPage(request, 'manage.loginFailed.title', 'manage.loginFailed.text'))

    app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(`${MANAGE_PATH}/callback`, async (request, reply) => {
      const outcome = await signIn.finish(request, reply)
      if (outcome.kind === 'redirected') return reply
      if (outcome.kind === 'failed') return failed(request, reply, outcome.status)
      const { claims } = outcome

      const who = await callApi(request, outcome.accessToken, { method: 'GET', url: '/whoami' })
      if (who.statusCode === 401) {
        return reply
          .code(403)
          .type('text/html')
          .header('Set-Cookie', signIn.clearCookie())
          .send(publicPage(request, 'manage.notAdmin.title', 'manage.notAdmin.text', { name: claims.name ?? claims.email ?? '' }, false))
      }
      if (who.statusCode !== 200) return failed(request, reply, 502)
      const person = who.json().user as { id: string; email: string; firstName: string; lastName: string; language: string }

      const lifetime = Math.min(outcome.expiresIn ?? 3600, MAX_SESSION_SECONDS)
      const session: ManageSession = {
        token: outcome.accessToken,
        idToken: outcome.idToken,
        user: { id: person.id, name: `${person.firstName} ${person.lastName}`.trim() || person.email, language: person.language },
        expiresAt: Date.now() + lifetime * 1000,
      }
      reply.header('Set-Cookie', [cookie(SESSION_COOKIE, sign(cookieKeys, session), lifetime), signIn.clearCookie()])
      return reply.redirect(outcome.next, 303)
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

    // Only says so. The cookie was removed by the POST above, which another site cannot send; a page that removed
    // it too would let any link on any site end the session.
    app.get(`${MANAGE_PATH}/signed-out`, async (request, reply) => reply.type('text/html').send(publicPage(request, 'manage.signedOut.title', 'manage.signedOut.text')))

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
    registerClients(app, ctx)
    registerClaimTypes(app, ctx)
    registerAudit(app, ctx)
    registerImport(app, ctx)
  }
