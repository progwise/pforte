import formbody from '@fastify/formbody'
import type { Database } from '@progwise/pforte-db'
import { changeCodeChannel, checkCode, CodeLimitError, currentCode, issueCode, markEmailVerified } from '@progwise/pforte-db/codes'
import { DEVICE_LIFETIME_MS, findRememberedDevice, rememberDevice } from '@progwise/pforte-db/devices'
import { findActiveUserById } from '@progwise/pforte-db/oidc'
import { recordLogin } from '@progwise/pforte-db/users'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ACR_PASSWORD, ACR_SECOND_FACTOR, secondFactorAssurance } from '../auth/assurance.js'
import { channelFor, maskEmail, maskPhone } from '../auth/channels.js'
import { deriveCodeSecrets } from '../auth/code-secrets.js'
import type { Authenticate, AuthResult } from '../auth/authenticate.js'
import type { LoginAudit, Origin } from '../auth/login-audit.js'
import type { RateLimiter } from '../auth/rate-limiter.js'
import { type Channel, type Notifier, NotifierUnavailableError } from '../notifications/notifier.js'
import { applyIssuerHeaders } from '../oidc/issuer-headers.js'
import type { ProviderHolder } from '../oidc/provider.js'
import { parseAcceptLanguage } from '../i18n/index.js'
import type { Ui } from '../ui/index.js'
import type { PageSet } from '../ui/pages.js'
import { tooManyRequests } from '../ui/too-many.js'
import { refuseForeignPosts } from '../security/origin-check.js'
import { readCookie, setCookieHeader, sign, unsign } from './signed-cookie.js'

export interface InteractionDependencies {
  provider: Pick<ProviderHolder, 'current' | 'issuer'>
  authenticate: Authenticate
  db: Database
  notifier: Notifier
  /** The cookie keys of the service: they sign the step cookie and, derived, the one-time codes. */
  cookieKeys: string[]
  /** The pages and their languages. */
  ui: Ui
  /** Says when somebody has tried too often. */
  limiter: RateLimiter
  /** Tells the audit log what happened to attempts to sign in. */
  audit: LoginAudit
}

const STEP_COOKIE = 'pforte_second_factor'
const STEP_LIFETIME_SECONDS = 15 * 60
/** Holds the tokens of remembered devices. Tokens are base64url, so a dot cannot occur inside one. */
const DEVICE_COOKIE = 'pforte_device'
/** One browser can be used by several people; each keeps a token, the newest few are kept. */
const MAX_DEVICE_TOKENS = 5

interface Step {
  uid: string
  userId: string
  expiresAt: number
  /** The language of the pages, fixed when the password was accepted. */
  language: string
}

/** The login pages the provider redirects to ("interactions"). */
export const interactionRoutes =
  ({ provider, authenticate, db, notifier, cookieKeys, ui, limiter, audit }: InteractionDependencies) =>
  async (app: FastifyInstance) => {
    await app.register(formbody)

    const originOf = (request: FastifyRequest): Origin => ({ ip: request.ip, userAgent: request.headers['user-agent'] })
    const secure = provider.issuer.startsWith('https:')
    const codeSecrets = deriveCodeSecrets(cookieKeys)
    const cookiePath = (uid: string) => `/interaction/${encodeURIComponent(uid)}`

    ui.pages.addHeaders(app)
    app.addHook(
      'onRequest',
      refuseForeignPosts(provider.issuer, (request, reply) => {
        const view = ui.pages.for(languageOf(request))
        return reply.code(403).type('text/html').send(view.notice(view.t('error.refusedTitle'), view.t('error.refused')))
      }),
    )

    /** The interaction this request belongs to, or undefined if the cookie or uid does not match. */
    const interactionFor = async (request: FastifyRequest, reply: FastifyReply, uid: string) => {
      applyIssuerHeaders(request.raw, provider.issuer)
      try {
        const details = await provider.current().interactionDetails(request.raw, reply.raw)
        return details.uid === uid ? details : undefined
      } catch {
        return undefined
      }
    }

    /**
     * The language of the pages: what the application asked for (`ui_locales`), else the user's own,
     * else the browser's, else the default.
     */
    const languageOf = (request: FastifyRequest, params?: Record<string, unknown>, userLanguage?: string) =>
      ui.i18n.pick(
        typeof params?.ui_locales === 'string' ? params.ui_locales.split(' ') : undefined,
        userLanguage,
        parseAcceptLanguage(request.headers['accept-language']),
      )

    const expired = (request: FastifyRequest, reply: FastifyReply) => {
      const view = ui.pages.for(languageOf(request))
      return reply.code(400).type('text/html').send(view.notice(view.t('error.signInExpiredTitle'), view.t('error.signInExpired')))
    }

    app.get<{ Params: { uid: string } }>('/interaction/:uid', async (request, reply) => {
      const details = await interactionFor(request, reply, request.params.uid)
      if (!details) return expired(request, reply)

      if (details.prompt.name === 'consent') {
        // There is no consent screen: every client is first-party. The library still asks for
        // consent when a client sends prompt=consent (which the OpenID spec prescribes together
        // with offline_access) or asks for more than the grant covers. Grant what is missing.
        const { Grant } = provider.current()
        const missing = details.prompt.details as { missingOIDCScope?: string[]; missingOIDCClaims?: string[] }
        const grant =
          (details.grantId && (await Grant.find(details.grantId))) ||
          new Grant({ accountId: details.session?.accountId, clientId: String(details.params.client_id) })
        if (missing.missingOIDCScope) grant.addOIDCScope(missing.missingOIDCScope.join(' '))
        if (missing.missingOIDCClaims) grant.addOIDCClaims(missing.missingOIDCClaims)

        const grantId = await grant.save()
        reply.hijack()
        await provider
          .current()
          .interactionFinished(request.raw, reply.raw, { consent: { grantId } }, { mergeWithLastSubmission: true })
        return
      }

      if (details.prompt.name !== 'login') {
        request.log.warn({ prompt: details.prompt.name, reasons: details.prompt.reasons }, 'unsupported interaction prompt')
        const view = ui.pages.for(languageOf(request, details.params))
        return reply.code(400).type('text/html').send(view.notice(view.t('error.notSupportedTitle'), view.t('error.notSupported')))
      }

      const client = await provider.current().Client.find(String(details.params.client_id))
      const loginHint = details.params.login_hint
      return reply
        .type('text/html')
        .send(
          ui.pages.for(languageOf(request, details.params)).login({
            uid: details.uid,
            clientName: client?.clientName,
            // The application may suggest who is signing in (OpenID Connect `login_hint`).
            email: typeof loginHint === 'string' ? loginHint : '',
          }),
        )
    })

    app.post<{ Params: { uid: string }; Body: { email?: unknown; password?: unknown } }>(
      '/interaction/:uid/login',
      async (request, reply) => {
        const details = await interactionFor(request, reply, request.params.uid)
        if (!details) return expired(request, reply)

        const { email, password } = request.body ?? {}
        const address = typeof email === 'string' ? email : ''
        const view = ui.pages.for(languageOf(request, details.params))

        // Before the password is looked at, so a blocked address learns nothing from a right or wrong guess.
        const wait = await limiter.passwordBlockedFor(address, request.ip)
        if (wait > 0) {
          await audit.blocked(originOf(request), { scope: 'password', email: address })
          return tooManyRequests(reply, view, wait)
        }

        const result: AuthResult =
          typeof email === 'string' && typeof password === 'string'
            ? await authenticate(email, password)
            : { ok: false, reason: 'wrong_password' }

        if (!result.ok) {
          await limiter.passwordFailed(address, request.ip)
          await audit.passwordFailed(originOf(request), { email: address, reason: result.reason, userId: result.userId })
          const client = await provider.current().Client.find(String(details.params.client_id))
          return reply
            .code(401)
            .type('text/html')
            .send(
              view.login({
                uid: details.uid,
                clientName: client?.clientName,
                email: typeof email === 'string' ? email : '',
                error: view.t('login.wrong'),
              }),
            )
        }

        await limiter.passwordSucceeded(address, request.ip)
        return startSecondFactor(request, reply, details, result.userId)
      },
    )

    const deviceTokens = (request: FastifyRequest) =>
      (readCookie(request.headers.cookie, DEVICE_COOKIE) ?? '').split('.').filter(Boolean).slice(0, MAX_DEVICE_TOKENS)

    const isRemembered = async (request: FastifyRequest, userId: string) =>
      Boolean(await findRememberedDevice(db, userId, deviceTokens(request)))

    /** Ends the interaction with a successful login. */
    const finishLogin = async (
      request: FastifyRequest,
      reply: FastifyReply,
      accountId: string,
      assurance: { acr: string; amr: string[] },
      headers: string[] = [],
    ) => {
      if (headers.length > 0) reply.raw.setHeader('Set-Cookie', headers)
      reply.hijack()
      await provider
        .current()
        .interactionFinished(request.raw, reply.raw, { login: { accountId, ...assurance } }, { mergeWithLastSubmission: false })
    }

    /** The step cookie, if it is valid, belongs to this interaction and the user can still sign in. */
    const stepFor = async (request: FastifyRequest, uid: string) => {
      const step = unsign<Step>(cookieKeys, readCookie(request.headers.cookie, STEP_COOKIE))
      if (!step || step.uid !== uid || step.expiresAt < Date.now()) return undefined
      const user = await findActiveUserById(db, step.userId)
      return user ? { step, user } : undefined
    }

    type StepUser = NonNullable<Awaited<ReturnType<typeof stepFor>>>['user']

    /** The code page, telling where the code that is valid now was sent. */
    const codePageFor = async (user: StepUser, uid: string, language: string, extra: { error?: string; notice?: string } = {}) => {
      const channel = (await currentCode(db, { userId: user.id, purpose: 'login' }))?.channel ?? 'email'
      return ui.pages.for(language).code({
        uid,
        channel,
        sentTo: channel === 'sms' && user.phone ? maskPhone(user.phone) : maskEmail(user.email),
        canUseEmail: channel === 'sms',
        // Only worth saying when codes could go by SMS at all.
        phoneHint: !user.phone && notifier.smsAvailable,
        ...extra,
      })
    }

    /**
     * Sends a fresh code, by SMS if the user can receive one and `wanted` allows it. When the SMS cannot be
     * sent the same code goes by e-mail, so a provider outage does not lock people out. Returns the channel used.
     */
    const sendCode = async (user: StepUser, wanted: Channel): Promise<Channel> => {
      const { code, expiresAt } = await issueCode(db, { userId: user.id, channel: wanted, purpose: 'login' }, { secrets: codeSecrets })
      try {
        await notifier.sendLoginCode(user, { code, expiresAt, channel: wanted })
        return wanted
      } catch (error) {
        if (wanted !== 'sms' || !(error instanceof NotifierUnavailableError)) throw error
        app.log.warn(error, 'the sign-in code could not be sent by SMS; sent by e-mail instead')
        await changeCodeChannel(db, { userId: user.id, purpose: 'login', channel: 'email' })
        await notifier.sendLoginCode(user, { code, expiresAt, channel: 'email' })
        return 'email'
      }
    }

    const limitMessage = (view: PageSet, error: CodeLimitError) =>
      error.reason === 'cooldown'
        ? view.t('code.cooldown', { seconds: error.retryAfterSeconds })
        : view.t('code.tooMany', { minutes: Math.ceil(error.retryAfterSeconds / 60) })

    const cannotSend = (reply: FastifyReply, view: PageSet, error: NotifierUnavailableError) => {
      reply.log.error(error, 'the sign-in code could not be sent')
      return reply.code(503).type('text/html').send(view.notice(view.t('error.cannotSendTitle'), view.t('error.cannotSend')))
    }

    /** The password was right: send the code and ask for it. */
    const startSecondFactor = async (
      request: FastifyRequest,
      reply: FastifyReply,
      { uid, params }: { uid: string; params: Record<string, unknown> },
      userId: string,
    ) => {
      const acrValues = params.acr_values
      const user = await findActiveUserById(db, userId)
      if (!user) return expired(request, reply)
      const language = languageOf(request, params, user.language)
      const view = ui.pages.for(language)

      // A remembered device skips the code, unless the application asks for the stronger
      // assurance: then the second factor is required whatever the browser remembers.
      const requested = typeof acrValues === 'string' ? acrValues.split(' ') : []
      if (!requested.includes(ACR_SECOND_FACTOR) && (await isRemembered(request, user.id))) {
        await recordLogin(db, user.id)
        await audit.succeeded(originOf(request), { userId: user.id, method: 'remembered_device', acr: ACR_PASSWORD })
        return finishLogin(request, reply, user.id, { acr: ACR_PASSWORD, amr: ['pwd'] })
      }

      // The first code needs no limit per IP: it only goes out after the right password, and per user
      // a code can be sent once a minute. Only asking again is counted (see the resend route).
      try {
        const wanted = channelFor(user, notifier)
        const used = await sendCode(user, wanted)
        await audit.codeSent(originOf(request), { userId: user.id, purpose: 'login', channel: used, fellBack: used !== wanted })
      } catch (error) {
        if (error instanceof NotifierUnavailableError) return cannotSend(reply, view, error)
        if (!(error instanceof CodeLimitError)) throw error
        // Not a fresh sign-in after all, but repeated requests: the code sent earlier still works.
        if (error.reason === 'too_many') {
          return reply.code(429).header('Retry-After', error.retryAfterSeconds).type('text/html').send(view.notice(view.t('code.tooManyTitle'), limitMessage(view, error)))
        }
        // A code went out a moment ago and still works.
      }

      const step: Step = { uid, userId, language, expiresAt: Date.now() + STEP_LIFETIME_SECONDS * 1000 }
      reply.header('Set-Cookie', setCookieHeader(STEP_COOKIE, sign(cookieKeys, step), { path: cookiePath(uid), maxAgeSeconds: STEP_LIFETIME_SECONDS, secure }))
      return reply.redirect(`${cookiePath(uid)}/code`, 303)
    }

    app.get<{ Params: { uid: string } }>('/interaction/:uid/code', async (request, reply) => {
      const details = await interactionFor(request, reply, request.params.uid)
      if (!details) return expired(request, reply)
      const current = await stepFor(request, details.uid)
      if (!current) return reply.redirect(cookiePath(details.uid), 303)
      return reply.type('text/html').send(await codePageFor(current.user, details.uid, current.step.language))
    })

    app.post<{ Params: { uid: string }; Body: { code?: unknown; remember?: unknown } }>('/interaction/:uid/code', async (request, reply) => {
      const details = await interactionFor(request, reply, request.params.uid)
      if (!details) return expired(request, reply)
      const current = await stepFor(request, details.uid)
      if (!current) return reply.redirect(cookiePath(details.uid), 303)
      const { user } = current

      const wait = await limiter.codeBlockedFor(request.ip)
      if (wait > 0) {
        await audit.blocked(originOf(request), { scope: 'code' })
        return tooManyRequests(reply, ui.pages.for(current.step.language), wait)
      }

      const code = typeof request.body?.code === 'string' ? request.body.code.replaceAll(' ', '') : ''
      const result = /^\d{6}$/.test(code)
        ? await checkCode(db, { userId: user.id, purpose: 'login', code }, { secrets: codeSecrets })
        : ({ ok: false, reason: 'wrong' } as const)

      if (!result.ok) {
        if (result.reason === 'wrong' || result.reason === 'exhausted') await limiter.codeFailed(request.ip)
        await audit.codeFailed(originOf(request), { userId: user.id, purpose: 'login', reason: result.reason })
        const error = ui.pages.for(current.step.language).t(`code.${result.reason}`)
        return reply.code(401).type('text/html').send(await codePageFor(user, details.uid, current.step.language, { error }))
      }

      if (result.channel === 'email') await markEmailVerified(db, user.id)
      await recordLogin(db, user.id)
      await audit.succeeded(originOf(request), { userId: user.id, method: 'code', channel: result.channel, acr: secondFactorAssurance(result.channel).acr })

      const cookies = [setCookieHeader(STEP_COOKIE, '', { path: cookiePath(details.uid), maxAgeSeconds: 0, secure })]
      if (request.body?.remember === 'on') {
        const { token } = await rememberDevice(db, { userId: user.id, userAgent: request.headers['user-agent'] })
        const tokens = [...deviceTokens(request), token].slice(-MAX_DEVICE_TOKENS)
        cookies.push(
          setCookieHeader(DEVICE_COOKIE, tokens.join('.'), { path: '/interaction', maxAgeSeconds: DEVICE_LIFETIME_MS / 1000, secure }),
        )
      }
      return finishLogin(request, reply, user.id, secondFactorAssurance(result.channel), cookies)
    })

    app.post<{ Params: { uid: string }; Body: { channel?: unknown } }>('/interaction/:uid/code/resend', async (request, reply) => {
      const details = await interactionFor(request, reply, request.params.uid)
      if (!details) return expired(request, reply)
      const current = await stepFor(request, details.uid)
      if (!current) return reply.redirect(cookiePath(details.uid), 303)

      const sendWait = await limiter.codeResend(request.ip)
      if (sendWait > 0) {
        await audit.blocked(originOf(request), { scope: 'code_resend' })
        return tooManyRequests(reply, ui.pages.for(current.step.language), sendWait)
      }

      // "Send it by e-mail instead" asks for the e-mail even where an SMS would be the usual way.
      const wanted = request.body?.channel === 'email' ? 'email' : channelFor(current.user, notifier)
      try {
        const used = await sendCode(current.user, wanted)
        await audit.codeSent(originOf(request), { userId: current.user.id, purpose: 'login', channel: used, fellBack: used !== wanted })
      } catch (error) {
        const view = ui.pages.for(current.step.language)
        if (error instanceof NotifierUnavailableError) return cannotSend(reply, view, error)
        if (!(error instanceof CodeLimitError)) throw error
        return reply
          .code(429)
          .header('Retry-After', error.retryAfterSeconds)
          .type('text/html')
          .send(await codePageFor(current.user, details.uid, current.step.language, { error: limitMessage(view, error) }))
      }
      return reply
        .type('text/html')
        .send(await codePageFor(current.user, details.uid, current.step.language, { notice: ui.pages.for(current.step.language).t('code.newOnItsWay') }))
    })

    app.post<{ Params: { uid: string } }>('/interaction/:uid/abort', async (request, reply) => {
      const details = await interactionFor(request, reply, request.params.uid)
      if (!details) return expired(request, reply)

      reply.hijack()
      await provider
        .current()
        .interactionFinished(
          request.raw,
          reply.raw,
          { error: 'access_denied', error_description: 'The user cancelled the sign-in.' },
          { mergeWithLastSubmission: false },
        )
    })
  }
