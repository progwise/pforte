import { createHmac } from 'node:crypto'
import formbody from '@fastify/formbody'
import type { Database } from '@progwise/pforte-db'
import { checkCode, CodeLimitError, issueCode, markEmailVerified } from '@progwise/pforte-db/codes'
import { DEVICE_LIFETIME_MS, findRememberedDevice, rememberDevice } from '@progwise/pforte-db/devices'
import { findActiveUserById } from '@progwise/pforte-db/oidc'
import { recordLogin } from '@progwise/pforte-db/users'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ACR_PASSWORD, ACR_SECOND_FACTOR, secondFactorAssurance } from '../auth/assurance.js'
import type { Authenticate } from '../auth/authenticate.js'
import { type Notifier, NotifierUnavailableError } from '../notifications/notifier.js'
import { applyIssuerHeaders } from '../oidc/issuer-headers.js'
import type { ProviderHolder } from '../oidc/provider.js'
import { readCookie, setCookieHeader, sign, unsign } from './signed-cookie.js'
import { codePage, contentSecurityPolicy, errorPage, loginPage } from './templates.js'

export interface InteractionDependencies {
  provider: Pick<ProviderHolder, 'current' | 'issuer'>
  authenticate: Authenticate
  db: Database
  notifier: Notifier
  /** The cookie keys of the service: they sign the step cookie and, derived, the one-time codes. */
  cookieKeys: string[]
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
}

/** `anna.schmidt@example.com` → `a***@example.com`: enough to recognise the mailbox, not to harvest it. */
const maskEmail = (email: string) => `${email.slice(0, 1)}***${email.slice(email.lastIndexOf('@'))}`

const GENERIC_LOGIN_ERROR = 'The e-mail or password is not correct.'

/** The login pages the provider redirects to ("interactions"). */
export const interactionRoutes =
  ({ provider, authenticate, db, notifier, cookieKeys }: InteractionDependencies) =>
  async (app: FastifyInstance) => {
    await app.register(formbody)

    const secure = provider.issuer.startsWith('https:')
    const codeSecrets = cookieKeys.map((key) => createHmac('sha256', key).update('one-time-code').digest('hex'))
    const cookiePath = (uid: string) => `/interaction/${encodeURIComponent(uid)}`

    app.addHook('onSend', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store')
      reply.header('Content-Security-Policy', contentSecurityPolicy)
      reply.header('X-Content-Type-Options', 'nosniff')
      reply.header('Referrer-Policy', 'no-referrer')
    })

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

    const expired = (reply: FastifyReply) =>
      reply
        .code(400)
        .type('text/html')
        .send(errorPage('Sign-in expired', 'This sign-in request has expired. Please go back to the application and start again.'))

    app.get<{ Params: { uid: string } }>('/interaction/:uid', async (request, reply) => {
      const details = await interactionFor(request, reply, request.params.uid)
      if (!details) return expired(reply)

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
        return reply.code(400).type('text/html').send(errorPage('Not supported', 'This request cannot be completed.'))
      }

      const client = await provider.current().Client.find(String(details.params.client_id))
      const loginHint = details.params.login_hint
      return reply
        .type('text/html')
        .send(
          loginPage({
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
        if (!details) return expired(reply)

        const { email, password } = request.body ?? {}
        const result =
          typeof email === 'string' && typeof password === 'string' ? await authenticate(email, password) : undefined

        if (!result) {
          const client = await provider.current().Client.find(String(details.params.client_id))
          return reply
            .code(401)
            .type('text/html')
            .send(
              loginPage({
                uid: details.uid,
                clientName: client?.clientName,
                email: typeof email === 'string' ? email : '',
                error: GENERIC_LOGIN_ERROR,
              }),
            )
        }

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

    const codePageFor = (
      user: { email: string; phone: string | null },
      uid: string,
      extra: { error?: string; notice?: string } = {},
    ) => codePage({ uid, sentTo: maskEmail(user.email), phoneHint: !user.phone, ...extra })

    /** Sends a fresh code to the user. Returns a message for the page when the limits say to wait. */
    const sendCode = async (user: NonNullable<Awaited<ReturnType<typeof stepFor>>>['user']) => {
      const { code, expiresAt } = await issueCode(db, { userId: user.id, channel: 'email', purpose: 'login' }, { secrets: codeSecrets })
      await notifier.sendLoginCode(user, { code, expiresAt })
    }

    const limitMessage = (error: CodeLimitError) =>
      error.reason === 'cooldown'
        ? `A code was sent a moment ago. You can ask for a new one in ${error.retryAfterSeconds} seconds.`
        : `Too many codes were requested. Please try again in ${Math.ceil(error.retryAfterSeconds / 60)} minutes.`

    const cannotSend = (reply: FastifyReply, error: NotifierUnavailableError) => {
      reply.log.error(error, 'the sign-in code could not be sent')
      return reply.code(503).type('text/html').send(errorPage('Cannot send the code', 'The code could not be sent. Please try again later.'))
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
      if (!user) return expired(reply)

      // A remembered device skips the code, unless the application asks for the stronger
      // assurance: then the second factor is required whatever the browser remembers.
      const requested = typeof acrValues === 'string' ? acrValues.split(' ') : []
      if (!requested.includes(ACR_SECOND_FACTOR) && (await isRemembered(request, user.id))) {
        await recordLogin(db, user.id)
        return finishLogin(request, reply, user.id, { acr: ACR_PASSWORD, amr: ['pwd'] })
      }

      try {
        await sendCode(user)
      } catch (error) {
        if (error instanceof NotifierUnavailableError) return cannotSend(reply, error)
        if (!(error instanceof CodeLimitError)) throw error
        // Not a fresh sign-in after all, but repeated requests: the code sent earlier still works.
        if (error.reason === 'too_many') {
          return reply.code(429).header('Retry-After', error.retryAfterSeconds).type('text/html').send(errorPage('Too many codes', limitMessage(error)))
        }
        // A code went out a moment ago and still works.
      }

      const step: Step = { uid, userId, expiresAt: Date.now() + STEP_LIFETIME_SECONDS * 1000 }
      reply.header('Set-Cookie', setCookieHeader(STEP_COOKIE, sign(cookieKeys, step), { path: cookiePath(uid), maxAgeSeconds: STEP_LIFETIME_SECONDS, secure }))
      return reply.redirect(`${cookiePath(uid)}/code`, 303)
    }

    app.get<{ Params: { uid: string } }>('/interaction/:uid/code', async (request, reply) => {
      const details = await interactionFor(request, reply, request.params.uid)
      if (!details) return expired(reply)
      const current = await stepFor(request, details.uid)
      if (!current) return reply.redirect(cookiePath(details.uid), 303)
      return reply.type('text/html').send(codePageFor(current.user, details.uid))
    })

    app.post<{ Params: { uid: string }; Body: { code?: unknown; remember?: unknown } }>('/interaction/:uid/code', async (request, reply) => {
      const details = await interactionFor(request, reply, request.params.uid)
      if (!details) return expired(reply)
      const current = await stepFor(request, details.uid)
      if (!current) return reply.redirect(cookiePath(details.uid), 303)
      const { user } = current

      const code = typeof request.body?.code === 'string' ? request.body.code.replaceAll(' ', '') : ''
      const result = /^\d{6}$/.test(code)
        ? await checkCode(db, { userId: user.id, purpose: 'login', code }, { secrets: codeSecrets })
        : ({ ok: false, reason: 'wrong' } as const)

      if (!result.ok) {
        const error = {
          wrong: 'The code is not correct.',
          exhausted: 'Too many wrong attempts. Please ask for a new code.',
          expired: 'The code has expired. Please ask for a new one.',
          none: 'There is no valid code. Please ask for a new one.',
        }[result.reason]
        return reply.code(401).type('text/html').send(codePageFor(user, details.uid, { error }))
      }

      if (result.channel === 'email') await markEmailVerified(db, user.id)
      await recordLogin(db, user.id)

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

    app.post<{ Params: { uid: string } }>('/interaction/:uid/code/resend', async (request, reply) => {
      const details = await interactionFor(request, reply, request.params.uid)
      if (!details) return expired(reply)
      const current = await stepFor(request, details.uid)
      if (!current) return reply.redirect(cookiePath(details.uid), 303)

      try {
        await sendCode(current.user)
      } catch (error) {
        if (error instanceof NotifierUnavailableError) return cannotSend(reply, error)
        if (!(error instanceof CodeLimitError)) throw error
        return reply
          .code(429)
          .header('Retry-After', error.retryAfterSeconds)
          .type('text/html')
          .send(codePageFor(current.user, details.uid, { error: limitMessage(error) }))
      }
      return reply.type('text/html').send(codePageFor(current.user, details.uid, { notice: 'A new code is on its way.' }))
    })

    app.post<{ Params: { uid: string } }>('/interaction/:uid/abort', async (request, reply) => {
      const details = await interactionFor(request, reply, request.params.uid)
      if (!details) return expired(reply)

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
