import formbody from '@fastify/formbody'
import type { Database } from '@progwise/pforte-db'
import { findGrantOfAccessToken } from '@progwise/pforte-db/admin'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ACR_SECOND_FACTOR } from '../auth/assurance.js'
import { canConfirmPhone, maskPhone } from '../auth/channels.js'
import type { LoginAudit } from '../auth/login-audit.js'
import type { SendPasswordResetCode } from '../auth/password-reset.js'
import type { RateLimiter } from '../auth/rate-limiter.js'
import { parseAcceptLanguage } from '../i18n/index.js'
import { withWait } from '../i18n/duration.js'
import type { MessageKey, Translate } from '../i18n/index.js'
import type { Notifier } from '../notifications/notifier.js'
import type { ClientLogouts } from '../oidc/client-logouts.js'
import { createLogoutLanguage } from '../oidc/logout-language.js'
import { createFlash, type Flash } from '../own-login/flash.js'
import { safeNext } from '../own-login/oidc.js'
import { createOwnSignIn } from '../own-login/sign-in.js'
import type { Passkeys } from '../passkeys/index.js'
import type { Background } from '../security/background.js'
import { refuseForeignPosts } from '../security/origin-check.js'
import type { Ui } from '../ui/index.js'
import { escapeHtml, type PageSet } from '../ui/pages.js'
import { ACCOUNT_PATH, ACCOUNT_UI_CLIENT_ID } from './constants.js'
import { registerPasskeyPages } from './passkey-pages.js'
import { PHONE_CHANGE, registerPhoneChangePages } from './phone-change-pages.js'
import { PHONE, registerPhonePages } from './phone-pages.js'
import { registerSecurityPages } from './security-pages.js'
import { type AccountSession, type AccountUser, createAccountGate } from './session.js'

export interface AccountAreaDependencies {
  db: Database
  /** The public address of pforte. */
  issuer: string
  /** Sign the cookies of the area. */
  cookieKeys: string[]
  ui: Ui
  /** Where times are shown: an IANA time zone such as `Europe/Berlin`. */
  timeZone: string
  /** Tells the applications of a person who signs out everywhere. */
  clientLogouts: ClientLogouts
  /** Sends the code with which a person chooses a new password. */
  sendPasswordResetCode: SendPasswordResetCode
  /** The limit on asking for a new password, the same one as on the page for a forgotten one, and those on the code for the phone number. */
  limiter: Pick<RateLimiter, 'resetRequest' | 'codeResend' | 'codeBlockedFor' | 'codeFailed'>
  audit: Pick<LoginAudit, 'resetRequested' | 'codeSent' | 'codeFailed' | 'blocked'>
  /** Sends the code that confirms a phone number, where this installation sends SMS at all, and the notice of a new number. */
  notifier: Pick<Notifier, 'smsAvailable' | 'sendPhoneCode' | 'sendPhoneChanged'>
  /** Sends that notice after the answer, so that a mail server that is down does not turn a change into an error. */
  background: Background
  /** The secrets that sign one-time codes (see `deriveCodeSecrets`). */
  codeSecrets: string[]
  /** How a person gets a new passkey, and the script that asks the device. */
  passkeys: Pick<Passkeys, 'enrolment' | 'script'>
}

const LOGIN_COOKIE = 'pforte_account_login'
/** How old a sign-in may be for a change. Looking needs a session; changing needs a person who was just there. */
export const STEP_UP_SECONDS = 5 * 60
/** What a sign-in that was started as a step-up carries along, so its end knows to say "now repeat it". */
const STEP_UP_NOTE = 'step-up'

/**
 * The account pages: server-rendered pages under `/account` where every person who has an account sees how they
 * are signed in. A person signs in the way anybody does, with the second factor always required, and sees and
 * changes only themselves: who that is comes from `requireAccountSession` and from nowhere else.
 */
export const accountAreaRoutes =
  (dependencies: AccountAreaDependencies) =>
  async (app: FastifyInstance) => {
    const { db, issuer, cookieKeys, ui, timeZone } = dependencies
    await app.register(formbody)
    ui.pages.addHeaders(app)

    const secure = issuer.startsWith('https:')
    const gate = createAccountGate({ db, cookieKeys, secure })
    const logoutLanguage = createLogoutLanguage({ cookieKeys, secure })
    const acceptedLanguages = (request: FastifyRequest) => parseAcceptLanguage(request.headers['accept-language'])
    /** The pages in the person's own language once we know who they are, in the browser's before that. */
    const viewFor = (request: FastifyRequest, user?: Pick<AccountUser, 'language'>) => {
      const view = ui.pages.for(ui.i18n.pick(user?.language, acceptedLanguages(request)))
      const t: Translate = (key, values) => view.t(key, values)
      return { view, language: view.language, t }
    }

    app.addHook(
      'onRequest',
      refuseForeignPosts(issuer, (request, reply) => {
        const { view } = viewFor(request)
        return reply.code(403).type('text/html').send(view.notice(view.t('error.refusedTitle'), view.t('error.refused')))
      }),
    )

    // Messages from one page to the next. Lax like the other cookies of the area.
    const flash = createFlash({ cookie: 'pforte_account_flash', path: ACCOUNT_PATH, sameSite: 'Lax' })
    // A wait travels as a number of seconds and gets its words here, in the language of this page.
    const flashText = (t: Translate, message: Flash) => message.text ?? (message.key ? t(message.key, withWait(message.key, message.values)) : '')

    /**
     * A page for somebody who has no session: what the sign-in or the sign-out came to. A message the last action
     * left ("you were signed out everywhere") takes the place of the usual text. `language` is the one the way here
     * left behind, where there is one.
     */
    const publicPage = (request: FastifyRequest, reply: FastifyReply, titleKey: MessageKey, textKey: MessageKey, language?: string) => {
      const message = flash.take(request, reply, cookieKeys, secure)
      // Whoever was just signed out everywhere is still read to in their own language.
      const own = message?.language ?? language
      const { view, t } = viewFor(request, own ? { language: own } : undefined)
      return view.notice(t(titleKey), message ? flashText(t, message) : t(textKey), { href: `${ACCOUNT_PATH}/login`, label: t('account.signIn') })
    }

    const sections: { path: string; key: string; label: MessageKey }[] = [
      { path: ACCOUNT_PATH, key: 'start', label: 'account.nav.start' },
      { path: `${ACCOUNT_PATH}/sessions`, key: 'sessions', label: 'account.nav.sessions' },
      { path: `${ACCOUNT_PATH}/devices`, key: 'devices', label: 'account.nav.devices' },
      { path: `${ACCOUNT_PATH}/sign-ins`, key: 'sign-ins', label: 'account.nav.signIns' },
      { path: `${ACCOUNT_PATH}/passkeys`, key: 'passkeys', label: 'account.nav.passkeys' },
      { path: `${ACCOUNT_PATH}/password`, key: 'password', label: 'account.nav.password' },
    ]

    /** A page of the area for the person who is signed in, with the message the last action left. `content` is HTML that is already escaped. */
    const page = (request: FastifyRequest, reply: FastifyReply, user: AccountUser, current: string, title: string, content: string) => {
      const { view, t } = viewFor(request, user)
      const message = flash.take(request, reply, cookieKeys, secure)
      return view.manage({
        title,
        sectionsLabel: t('account.nav.label'),
        nav: sections.map((section) => ({ href: section.path, label: t(section.label), current: section.key === current })),
        person: {
          signedInAs: t('account.signedInAs', { name: `${user.firstName} ${user.lastName}`.trim() || user.email }),
          signOutLabel: t('account.signOut'),
          signOutAction: `${ACCOUNT_PATH}/logout`,
        },
        flash: message && { kind: message.kind, text: flashText(t, message) },
        content,
      })
    }

    /** Leave a message for the next page and go there. */
    const redirectWith = (reply: FastifyReply, to: string, message: Flash) => {
      flash.set(reply, cookieKeys, secure, message)
      return reply.redirect(to, 303)
    }

    /**
     * The step-up. Looking is allowed with the session; a change needs a sign-in with a code that is at most five
     * minutes old, and this is asked on every action, not once at sign-in. Otherwise the person signs in again
     * and comes back to `back`, the page they were on. What they were about to do is not carried along: they
     * repeat it, so nothing is changed by an answer to a question they did not see.
     * Returns false after sending the browser away.
     */
    const requireRecentSignIn = (reply: FastifyReply, session: AccountSession, back: string) => {
      if (session.acr === ACR_SECOND_FACTOR && Date.now() / 1000 - session.authTime <= STEP_UP_SECONDS) return true
      void reply.redirect(`${ACCOUNT_PATH}/login?again=1&next=${encodeURIComponent(back)}`, 303)
      return false
    }

    const formatTime = (time: Date | null | undefined, language: string) => {
      if (!time) return ''
      try {
        return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(time)
      } catch {
        return time.toISOString()
      }
    }

    // --- Signing in: pforte's own login, as any application, and always with the second factor

    // Lax for the same reason as the session cookie: a sign-in that starts with a click on another site must find
    // its own cookie again when it comes back.
    const signIn = createOwnSignIn(app, { issuer, cookieKeys, clientId: ACCOUNT_UI_CLIENT_ID, basePath: ACCOUNT_PATH, loginCookie: LOGIN_COOKIE, scope: 'openid', sameSite: 'Lax', acceptedLanguages })

    // `again` asks for a new sign-in although the browser has a session: the step-up before a change. That it is
    // one is noted in the sign-in itself, so the reminder to repeat the action is there however long the person
    // takes over password and code; a message left in a cookie now would have run out before a slow sign-in ended.
    app.get<{ Querystring: { next?: string; again?: string } }>(`${ACCOUNT_PATH}/login`, async (request, reply) => {
      const stepUp = request.query.again === '1'
      return signIn.begin(request, reply, safeNext(request.query.next, ACCOUNT_PATH), stepUp, stepUp ? STEP_UP_NOTE : undefined)
    })

    const failed = (request: FastifyRequest, reply: FastifyReply, status = 400) =>
      reply.code(status).type('text/html').header('Set-Cookie', signIn.clearCookie()).send(publicPage(request, reply, 'account.loginFailed.title', 'account.loginFailed.text'))

    app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(`${ACCOUNT_PATH}/callback`, async (request, reply) => {
      const outcome = await signIn.finish(request, reply)
      if (outcome.kind === 'redirected') return reply
      if (outcome.kind === 'failed') return failed(request, reply, outcome.status)

      const { sub, acr, auth_time: authTime } = outcome.claims
      if (typeof sub !== 'string' || typeof acr !== 'string' || typeof authTime !== 'number') return failed(request, reply)
      // The access token is used once, to learn which sign-in this is, and then dropped: nothing here is done with
      // a token, so none is kept. The session is tied to that sign-in and ends with it.
      const grant = await findGrantOfAccessToken(db, outcome.accessToken)
      if (!grant || grant.userId !== sub || grant.clientId !== ACCOUNT_UI_CLIENT_ID) return failed(request, reply)

      reply.header('Set-Cookie', [gate.start({ userId: sub, grantId: grant.grantId, acr, authTime }), signIn.clearCookie()])
      if (outcome.note === STEP_UP_NOTE) flash.set(reply, cookieKeys, secure, { kind: 'ok', key: 'account.stepUp.again' })
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

    // Only says so. The cookie was removed by the POST above, which another site cannot send; a page that removed
    // it too would let any link on any site end the session. In the language of the question pforte asked on the
    // way here, which was the person's own.
    app.get(`${ACCOUNT_PATH}/signed-out`, async (request, reply) => {
      const language = logoutLanguage.read(request.headers.cookie)
      const page = publicPage(request, reply, 'account.signedOut.title', 'account.signedOut.text', language)
      if (language) reply.header('Set-Cookie', logoutLanguage.forget())
      return reply.type('text/html').send(page)
    })

    // --- Start page: who am I. The organisation owns the name, the e-mail address and the language, so nothing here
    // changes them. The mobile number is the person's: they confirm the one that is stored, so that codes go to it,
    // or give another one. Both only where this pforte sends SMS.

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
      const { smsAvailable } = dependencies.notifier
      const changePhone = smsAvailable ? `<br><a href="${PHONE_CHANGE}">${escapeHtml(t(user.phone ? 'account.profile.changePhone' : 'account.profile.addPhone'))}</a>` : ''
      const content = `<h1>${escapeHtml(t('account.title'))}</h1>
<div class="panel">
<h2>${escapeHtml(t('account.profile.title'))}</h2>
<dl class="facts">
${fact('account.profile.name', `${user.firstName} ${user.lastName}`.trim())}
${fact('account.profile.email', user.email)}
${
  canConfirmPhone(user, dependencies.notifier)
    ? `<dt>${escapeHtml(t('account.profile.phone'))}</dt><dd>${escapeHtml(maskPhone(user.phone))}<br><span class="muted">${escapeHtml(t('account.profile.phoneUnconfirmed'))}</span>
<form method="post" action="${PHONE}/send"><button type="submit" class="secondary">${escapeHtml(t('account.phone.send'))}</button></form>${changePhone}</dd>`
    : `<dt>${escapeHtml(t('account.profile.phone'))}</dt><dd>${escapeHtml(user.phone ? maskPhone(user.phone) : t('account.profile.noPhone'))}${changePhone}</dd>`
}
${fact('account.profile.language', languageName)}
</dl>
<p class="muted">${escapeHtml(t(smsAvailable ? 'account.profile.noteOwnPhone' : 'account.profile.note'))}</p>
</div>`
      return reply.type('text/html').send(page(request, reply, user, 'start', t('account.title'), content))
    })

    const context: AccountContext = { ...dependencies, gate, viewFor, page, redirectWith, requireRecentSignIn, formatTime }
    registerSecurityPages(app, context)
    registerPasskeyPages(app, context)
    registerPhonePages(app, context)
    registerPhoneChangePages(app, context)
  }

/** What the pages of the area share: who the person is, how a page is drawn, and the step-up before a change. */
export interface AccountContext extends AccountAreaDependencies {
  gate: ReturnType<typeof createAccountGate>
  viewFor: (request: FastifyRequest, user?: Pick<AccountUser, 'language'>) => { view: PageSet; language: string; t: Translate }
  page: (request: FastifyRequest, reply: FastifyReply, user: AccountUser, current: string, title: string, content: string) => string
  redirectWith: (reply: FastifyReply, to: string, message: Flash) => FastifyReply
  requireRecentSignIn: (reply: FastifyReply, session: AccountSession, back: string) => boolean
  formatTime: (time: Date | null | undefined, language: string) => string
}
