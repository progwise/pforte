import formbody from '@fastify/formbody'
import { hash } from '@node-rs/argon2'
import type { Database } from '@progwise/pforte-db'
import { checkCode, CodeLimitError, issueCode, markEmailVerified, markPhoneVerified } from '@progwise/pforte-db/codes'
import { getClient } from '@progwise/pforte-db/admin'
import { findActiveUserById } from '@progwise/pforte-db/oidc'
import { completeActivation, completePasswordReset, findPendingActivation } from '@progwise/pforte-db/credentials'
import { findUserByEmail } from '@progwise/pforte-db/users'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { maskPhone } from '../auth/channels.js'
import type { LoginAudit } from '../auth/login-audit.js'
import type { RateLimiter } from '../auth/rate-limiter.js'
import { checkPassword } from '../auth/password-policy.js'
import type { SendPasswordResetCode } from '../auth/password-reset.js'
import { readCookie, setCookieHeader, sign, unsign } from '../interaction/signed-cookie.js'
import { parseAcceptLanguage } from '../i18n/index.js'
import { type Notifier, NotifierUnavailableError } from '../notifications/notifier.js'
import type { Ui } from '../ui/index.js'
import type { Background } from '../security/background.js'
import { refuseForeignPosts } from '../security/origin-check.js'
import type { PageSet } from '../ui/pages.js'
import { tooManyRequests } from '../ui/too-many.js'

export interface AccountDependencies {
  db: Database
  sendPasswordResetCode: SendPasswordResetCode
  /** The secrets that sign one-time codes (see `deriveCodeSecrets`). */
  codeSecrets: string[]
  /** Sends the code that confirms a phone number. */
  notifier: Pick<Notifier, 'smsAvailable' | 'sendPhoneCode'>
  /** Sign the cookie that carries the phone confirmation step. */
  cookieKeys: string[]
  /** Whether the service is reached over https, which makes cookies `Secure`. */
  secure: boolean
  /** The public address of pforte: forms are only accepted from pages served there. */
  issuer: string
  /** The pages and their languages. */
  ui: Ui
  /** Says when somebody has tried too often. */
  limiter: RateLimiter
  /** Tells the audit log what happened. */
  audit: LoginAudit
  /** Runs what must not delay an answer. */
  background: Background
}

const PHONE_COOKIE = 'pforte_phone_step'
const PHONE_STEP_SECONDS = 30 * 60
interface PhoneStep {
  userId: string
  expiresAt: number
  /** The application the person was invited to, for the button on the last page. */
  clientId?: string
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const normalizeEmail = (value: unknown) => text(value).trim().toLowerCase()

/** Pages that are not part of a sign-in: choosing the first password, and choosing a new one after forgetting it. */
export const accountRoutes =
  ({ db, sendPasswordResetCode, codeSecrets, notifier, cookieKeys, secure, issuer, ui, limiter, audit, background }: AccountDependencies) =>
  async (app: FastifyInstance) => {
    await app.register(formbody)
    ui.pages.addHeaders(app)
    app.addHook(
      'onRequest',
      refuseForeignPosts(issuer, (request, reply) => {
        const view = ui.pages.for(languageOf(request, (request.query as Record<string, unknown> | undefined)?.lang))
        return reply.code(403).type('text/html').send(view.notice(view.t('error.refusedTitle'), view.t('error.refused')))
      }),
    )

    const html = (reply: FastifyReply, status: number, body: string) => reply.code(status).type('text/html').send(body)
    const origin = (request: FastifyRequest) => ({ ip: request.ip, userAgent: request.headers['user-agent'] })

    /**
     * The language of a page: one given explicitly (a `lang` in the link or form), else the user's own where
     * the page is about a user who is already known, else the browser's, else the default. Pages that must
     * not reveal whether an address has an account never pass a user language.
     */
    const languageOf = (request: FastifyRequest, explicit?: unknown, userLanguage?: string) =>
      ui.i18n.pick(text(explicit) || undefined, userLanguage, parseAcceptLanguage(request.headers['accept-language']))

    /** The password and its repetition, checked against the policy. Returns what is wrong, if anything. */
    const passwordProblem = (view: PageSet, body: Record<string, unknown> | undefined, email: string) => {
      const password = text(body?.password)
      if (password !== text(body?.confirm)) return view.t('password.mismatch')
      const problem = checkPassword(password, email)
      return problem && view.t(problem.key, problem.values)
    }

    const invalidLink = (reply: FastifyReply, view: PageSet) =>
      html(reply, 400, view.notice(view.t('activate.invalidTitle'), view.t('activate.invalid')))
    /**
     * The button that leads on to the application, if the client is known and has a start address. Only the address
     * registered for the client is ever linked, never one that came with the request.
     */
    const continueTo = async (view: PageSet, clientId?: string) => {
      const client = clientId ? await getClient(db, clientId) : undefined
      return client?.clientUri ? { href: client.clientUri, label: view.t('continue.button', { name: client.name }) } : undefined
    }
    const activeAccount = async (view: PageSet, clientId?: string) =>
      view.notice(view.t('activate.doneTitle'), view.t('activate.done'), await continueTo(view, clientId))

    // --- First password, from the link in the activation e-mail

    app.get<{ Querystring: { token?: string; lang?: string } }>('/activate', async (request, reply) => {
      const token = text(request.query.token)
      const wait = await limiter.activationBlockedFor(request.ip)
      if (wait > 0) {
        await audit.blocked(origin(request), { scope: 'activation' })
        return tooManyRequests(reply, ui.pages.for(languageOf(request, request.query.lang)), wait)
      }

      const user = token ? await findPendingActivation(db, token) : undefined
      const view = ui.pages.for(languageOf(request, request.query.lang, user?.language))
      if (!user) {
        await limiter.activationFailed(request.ip)
        return invalidLink(reply, view)
      }
      return html(reply, 200, view.activation({ token }))
    })

    app.post<{ Body: Record<string, unknown> }>('/activate', async (request, reply) => {
      const token = text(request.body?.token)
      const wait = await limiter.activationBlockedFor(request.ip)
      if (wait > 0) {
        await audit.blocked(origin(request), { scope: 'activation' })
        return tooManyRequests(reply, ui.pages.for(languageOf(request, request.body?.lang)), wait)
      }

      const pending = token ? await findPendingActivation(db, token) : undefined
      const view = ui.pages.for(languageOf(request, request.body?.lang, pending?.language))
      if (!pending) {
        await limiter.activationFailed(request.ip)
        return invalidLink(reply, view)
      }

      const problem = passwordProblem(view, request.body, pending.email)
      if (problem) return html(reply, 422, view.activation({ token, error: problem }))

      const user = await completeActivation(db, { token, passwordHash: await hash(text(request.body?.password)), ...origin(request) })
      if (!user) return invalidLink(reply, view)

      // With SMS available, the number the back office entered is confirmed now, so that codes can go to it.
      if (notifier.smsAvailable && user.phone && !user.phoneVerifiedAt) {
        try {
          await sendPhoneCode(user)
          reply.header('Set-Cookie', phoneCookie(user.id, pending.activationClientId ?? undefined))
          return html(reply, 200, view.phoneConfirm({ sentTo: maskPhone(user.phone) }))
        } catch (error) {
          if (!(error instanceof NotifierUnavailableError)) throw error
          request.log.error(error, 'the code to confirm the phone number could not be sent')
        }
      }
      return html(reply, 200, await activeAccount(view, pending.activationClientId ?? undefined))
    })

    const phoneCookie = (userId: string, clientId?: string) =>
      setCookieHeader(PHONE_COOKIE, sign(cookieKeys, { userId, expiresAt: Date.now() + PHONE_STEP_SECONDS * 1000, ...(clientId ? { clientId } : {}) } satisfies PhoneStep), {
        path: '/activate',
        maxAgeSeconds: PHONE_STEP_SECONDS,
        secure,
      })

    const sendPhoneCode = async (user: { id: string; email: string; firstName: string; lastName: string; language: string; phone: string | null }) => {
      const { code, expiresAt } = await issueCode(db, { userId: user.id, channel: 'sms', purpose: 'activation' }, { secrets: codeSecrets })
      await notifier.sendPhoneCode(user, { code, expiresAt })
    }

    /** The user in the middle of confirming their phone, from the cookie set when the password was chosen. */
    const phoneStep = async (request: FastifyRequest) => {
      const step = unsign<PhoneStep>(cookieKeys, readCookie(request.headers.cookie, PHONE_COOKIE))
      if (!step || step.expiresAt < Date.now()) return undefined
      const user = await findActiveUserById(db, step.userId)
      return user?.phone && !user.phoneVerifiedAt ? { ...user, clientId: step.clientId } : undefined
    }

    const finishedPhoneStep = (reply: FastifyReply, page: string) => {
      reply.header('Set-Cookie', setCookieHeader(PHONE_COOKIE, '', { path: '/activate', maxAgeSeconds: 0, secure }))
      return html(reply, 200, page)
    }

    app.post<{ Body: Record<string, unknown> }>('/activate/phone', async (request, reply) => {
      const user = await phoneStep(request)
      const view = ui.pages.for(languageOf(request, undefined, user?.language))
      if (!user) return html(reply, 200, await activeAccount(view))

      const wait = await limiter.codeBlockedFor(request.ip)
      if (wait > 0) {
        await audit.blocked(origin(request), { scope: 'phone_code' })
        return tooManyRequests(reply, view, wait)
      }

      const code = text(request.body?.code).replaceAll(' ', '')
      const result = /^\d{6}$/.test(code) ? await checkCode(db, { userId: user.id, purpose: 'activation', code }, { secrets: codeSecrets }) : undefined
      if (!result?.ok) {
        await limiter.codeFailed(request.ip)
        await audit.codeFailed(origin(request), { userId: user.id, purpose: 'activation', reason: result?.reason ?? 'malformed' })
        return html(reply, 401, view.phoneConfirm({ sentTo: maskPhone(user.phone!), error: view.t('code.badOrExpired') }))
      }
      await markPhoneVerified(db, user.id)
      return finishedPhoneStep(reply, view.notice(view.t('phone.doneTitle'), view.t('phone.done'), await continueTo(view, user.clientId)))
    })

    app.post('/activate/phone/resend', async (request, reply) => {
      const user = await phoneStep(request)
      const view = ui.pages.for(languageOf(request, undefined, user?.language))
      if (!user) return html(reply, 200, await activeAccount(view))

      const sendWait = await limiter.codeResend(request.ip)
      if (sendWait > 0) {
        await audit.blocked(origin(request), { scope: 'code_resend' })
        return tooManyRequests(reply, view, sendWait)
      }

      try {
        await sendPhoneCode(user)
      } catch (error) {
        if (error instanceof CodeLimitError) {
          return html(reply, 429, view.phoneConfirm({ sentTo: maskPhone(user.phone!), error: view.t('phone.wait', { seconds: error.retryAfterSeconds }) }))
        }
        if (!(error instanceof NotifierUnavailableError)) throw error
        request.log.error(error, 'the code to confirm the phone number could not be sent')
        return html(reply, 503, view.phoneConfirm({ sentTo: maskPhone(user.phone!), error: view.t('phone.cannotSend') }))
      }
      return html(reply, 200, view.phoneConfirm({ sentTo: maskPhone(user.phone!), notice: view.t('code.newOnItsWay') }))
    })

    app.post('/activate/phone/skip', async (request, reply) => {
      const user = await phoneStep(request)
      return finishedPhoneStep(reply, await activeAccount(ui.pages.for(languageOf(request, undefined, user?.language)), user?.clientId))
    })

    // --- Forgotten password

    app.get<{ Querystring: { email?: string; lang?: string; client_id?: string } }>('/reset', async (request, reply) =>
      html(
        reply,
        200,
        ui.pages.for(languageOf(request, request.query.lang)).forgotPassword({ email: normalizeEmail(request.query.email), clientId: text(request.query.client_id) || undefined }),
      ),
    )

    app.post<{ Body: Record<string, unknown> }>('/reset', async (request, reply) => {
      const email = normalizeEmail(request.body?.email)
      const clientId = text(request.body?.client_id) || undefined
      const view = ui.pages.for(languageOf(request, request.body?.lang))
      if (!email.includes('@')) return html(reply, 400, view.forgotPassword({ email, clientId, error: view.t('reset.noEmail') }))

      // Every address is counted, existing or not, so being over the limit says nothing about an account.
      const wait = await limiter.resetRequest(email, request.ip)
      if (wait > 0) {
        await audit.blocked(origin(request), { scope: 'reset', email })
        return tooManyRequests(reply, view, wait)
      }

      // The answer is the same whether or not the address belongs to someone, and it is sent before anyone looks
      // for the account, so neither the page nor the time it takes can be used to find out who has one.
      const where = origin(request)
      // Started only once the response is out: while it is being written the lookup and the mail would compete
      // with it for the server's attention, and for an existing account that would make the answer a little slower.
      reply.raw.once('finish', () =>
        background.run(async () => {
          const user = await findUserByEmail(db, email)
          if (user?.status !== 'active' || !user.passwordHash) return
          try {
            const channel = await sendPasswordResetCode(user)
            await audit.resetRequested(where, { userId: user.id })
            await audit.codeSent(where, { userId: user.id, purpose: 'password_reset', channel })
          } catch (error) {
            if (error instanceof NotifierUnavailableError) request.log.error(error, 'the password reset code could not be sent')
            else if (!(error instanceof CodeLimitError)) throw error
          }
        }),
      )
      return html(reply, 200, view.resetCode({ email, clientId, notice: view.t('reset.sent') }))
    })

    app.get<{ Querystring: { email?: string; lang?: string; client_id?: string } }>('/reset/code', async (request, reply) =>
      html(
        reply,
        200,
        ui.pages.for(languageOf(request, request.query.lang)).resetCode({ email: normalizeEmail(request.query.email), clientId: text(request.query.client_id) || undefined }),
      ),
    )

    app.post<{ Body: Record<string, unknown> }>('/reset/code', async (request, reply) => {
      const email = normalizeEmail(request.body?.email)
      const clientId = text(request.body?.client_id) || undefined
      const view = ui.pages.for(languageOf(request, request.body?.lang))
      // Before the code is looked at, so that a typo in the password does not use up an attempt.
      const problem = passwordProblem(view, request.body, email)
      if (problem) return html(reply, 422, view.resetCode({ email, clientId, error: problem }))

      const wait = await limiter.codeBlockedFor(request.ip)
      if (wait > 0) {
        await audit.blocked(origin(request), { scope: 'reset_code', email })
        return tooManyRequests(reply, view, wait)
      }

      const code = text(request.body?.code).replaceAll(' ', '')
      const user = await findUserByEmail(db, email)
      // One answer for every way this can fail, so it reveals nothing about the account; all of them count.
      const refused = async (reason: string) => {
        await limiter.codeFailed(request.ip)
        await audit.codeFailed(origin(request), { userId: user?.id, email, purpose: 'password_reset', reason })
        return html(reply, 401, view.resetCode({ email, clientId, error: view.t('code.badOrExpired') }))
      }
      if (!user) return refused('unknown_user')
      if (user.status !== 'active' || !user.passwordHash) return refused('not_allowed')
      if (!/^\d{6}$/.test(code)) return refused('malformed')

      const result = await checkCode(db, { userId: user.id, purpose: 'password_reset', code }, { secrets: codeSecrets })
      if (!result.ok) return refused(result.reason)

      const changed = await completePasswordReset(db, { userId: user.id, passwordHash: await hash(text(request.body?.password)), ...origin(request) })
      if (!changed) return refused('not_allowed')
      if (result.channel === 'email') await markEmailVerified(db, user.id)
      return html(reply, 200, view.notice(view.t('reset.doneTitle'), view.t('reset.done'), await continueTo(view, clientId)))
    })
  }
