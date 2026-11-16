import formbody from '@fastify/formbody'
import type { Database } from '@progwise/pforte-db'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { maskPhone } from '../auth/channels.js'
import { parseAcceptLanguage } from '../i18n/index.js'
import type { MessageKey, Values } from '../i18n/index.js'
import { safeNext } from '../own-login/oidc.js'
import { createOwnSignIn } from '../own-login/sign-in.js'
import { refuseForeignPosts } from '../security/origin-check.js'
import type { Ui } from '../ui/index.js'
import { escapeHtml } from '../ui/pages.js'
import { ACCOUNT_PATH, ACCOUNT_UI_CLIENT_ID } from './constants.js'
import { type AccountUser, createAccountGate } from './session.js'

export interface AccountAreaDependencies {
  db: Database
  /** The public address of pforte. */
  issuer: string
  /** Sign the cookies of the area. */
  cookieKeys: string[]
  ui: Ui
}

const LOGIN_COOKIE = 'pforte_account_login'

/**
 * The account pages: server-rendered pages under `/account` where every person who has an account sees how they
 * are signed in. A person signs in the way anybody does, with the second factor always required, and sees and
 * changes only themselves: who that is comes from `requireAccountSession` and from nowhere else.
 */
export const accountAreaRoutes =
  ({ db, issuer, cookieKeys, ui }: AccountAreaDependencies) =>
  async (app: FastifyInstance) => {
    await app.register(formbody)
    ui.pages.addHeaders(app)

    const secure = issuer.startsWith('https:')
    const gate = createAccountGate({ db, cookieKeys, secure })
    const acceptedLanguages = (request: FastifyRequest) => parseAcceptLanguage(request.headers['accept-language'])
    /** The pages in the person's own language once we know who they are, in the browser's before that. */
    const viewFor = (request: FastifyRequest, user?: AccountUser) => {
      const view = ui.pages.for(ui.i18n.pick(user?.language, acceptedLanguages(request)))
      return { view, language: view.language, t: (key: MessageKey, values?: Values) => view.t(key, values) }
    }

    app.addHook(
      'onRequest',
      refuseForeignPosts(issuer, (request, reply) => {
        const { view } = viewFor(request)
        return reply.code(403).type('text/html').send(view.notice(view.t('error.refusedTitle'), view.t('error.refused')))
      }),
    )

    /** A page for somebody who has no session: what the sign-in or the sign-out came to. */
    const publicPage = (request: FastifyRequest, titleKey: MessageKey, textKey: MessageKey) => {
      const { view, t } = viewFor(request)
      return view.notice(t(titleKey), t(textKey), { href: `${ACCOUNT_PATH}/login`, label: t('account.signIn') })
    }

    /** A page of the area for the person who is signed in. `content` is HTML that is already escaped. */
    const page = (request: FastifyRequest, user: AccountUser, current: string, title: string, content: string) => {
      const { view, t } = viewFor(request, user)
      return view.manage({
        title,
        sectionsLabel: t('account.nav.label'),
        nav: [{ href: ACCOUNT_PATH, label: t('account.nav.start'), current: current === 'start' }],
        person: {
          signedInAs: t('account.signedInAs', { name: `${user.firstName} ${user.lastName}`.trim() || user.email }),
          signOutLabel: t('account.signOut'),
          signOutAction: `${ACCOUNT_PATH}/logout`,
        },
        content,
      })
    }

    // --- Signing in: pforte's own login, as any application, and always with the second factor

    // Lax for the same reason as the session cookie: a sign-in that starts with a click on another site must find
    // its own cookie again when it comes back.
    const signIn = createOwnSignIn(app, { issuer, cookieKeys, clientId: ACCOUNT_UI_CLIENT_ID, basePath: ACCOUNT_PATH, loginCookie: LOGIN_COOKIE, scope: 'openid', sameSite: 'Lax', acceptedLanguages })

    app.get<{ Querystring: { next?: string } }>(`${ACCOUNT_PATH}/login`, async (request, reply) => signIn.begin(request, reply, safeNext(request.query.next, ACCOUNT_PATH)))

    const failed = (request: FastifyRequest, reply: FastifyReply, status = 400) =>
      reply.code(status).type('text/html').header('Set-Cookie', signIn.clearCookie()).send(publicPage(request, 'account.loginFailed.title', 'account.loginFailed.text'))

    app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(`${ACCOUNT_PATH}/callback`, async (request, reply) => {
      const outcome = await signIn.finish(request, reply)
      if (outcome.kind === 'redirected') return reply
      if (outcome.kind === 'failed') return failed(request, reply, outcome.status)

      // The token is read and then dropped: nothing here is done with a token, so none is kept.
      const { sub, acr, auth_time: authTime } = outcome.claims
      if (typeof sub !== 'string' || typeof acr !== 'string' || typeof authTime !== 'number') return failed(request, reply)

      reply.header('Set-Cookie', [gate.start({ userId: sub, acr, authTime }), signIn.clearCookie()])
      return reply.redirect(outcome.next, 303)
    })

    // --- Signing out ends pforte's own session too: on a shared computer the next person must not walk in

    app.post(`${ACCOUNT_PATH}/logout`, async (request, reply) => {
      const had = gate.hasCookie(request)
      reply.header('Set-Cookie', gate.end())
      if (!had) return reply.redirect(`${ACCOUNT_PATH}/signed-out`, 303)
      const parameters = new URLSearchParams({ client_id: ACCOUNT_UI_CLIENT_ID, post_logout_redirect_uri: `${issuer}${ACCOUNT_PATH}/signed-out` })
      return reply.redirect(`${issuer}/session/end?${parameters}`, 303)
    })

    app.get(`${ACCOUNT_PATH}/signed-out`, async (request, reply) =>
      reply.type('text/html').header('Set-Cookie', gate.end()).send(publicPage(request, 'account.signedOut.title', 'account.signedOut.text')),
    )

    // --- Start page: who am I, read-only. The organisation owns these details, so nothing here changes them.

    app.get(ACCOUNT_PATH, async (request, reply) => {
      const signedIn = await gate.requireAccountSession(request, reply)
      if (!signedIn) return reply
      const { user } = signedIn
      const { t, language } = viewFor(request, user)

      let languageName = user.language
      try {
        languageName = new Intl.DisplayNames([language], { type: 'language' }).of(user.language) ?? user.language
      } catch {
        // not a language tag the runtime knows: the tag itself is shown
      }
      const fact = (label: MessageKey, value: string) => `<dt>${escapeHtml(t(label))}</dt><dd>${escapeHtml(value)}</dd>`
      const content = `<h1>${escapeHtml(t('account.title'))}</h1>
<div class="panel">
<h2>${escapeHtml(t('account.profile.title'))}</h2>
<dl class="facts">
${fact('account.profile.name', `${user.firstName} ${user.lastName}`.trim())}
${fact('account.profile.email', user.email)}
${fact('account.profile.phone', user.phone ? maskPhone(user.phone) : t('account.profile.noPhone'))}
${fact('account.profile.language', languageName)}
</dl>
<p class="muted">${escapeHtml(t('account.profile.note'))}</p>
</div>`
      return reply.type('text/html').send(page(request, user, 'start', t('account.title'), content))
    })
  }
