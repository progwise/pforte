import formbody from '@fastify/formbody'
import { hash } from '@node-rs/argon2'
import type { Database } from '@progwise/pforte-db'
import { checkCode, CodeLimitError, issueCode, markEmailVerified, markPhoneVerified } from '@progwise/pforte-db/codes'
import { findActiveUserById } from '@progwise/pforte-db/oidc'
import { completeActivation, completePasswordReset, findPendingActivation } from '@progwise/pforte-db/credentials'
import { findUserByEmail } from '@progwise/pforte-db/users'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { maskPhone } from '../auth/channels.js'
import { checkPassword } from '../auth/password-policy.js'
import type { SendPasswordResetCode } from '../auth/password-reset.js'
import { readCookie, setCookieHeader, sign, unsign } from '../interaction/signed-cookie.js'
import { activationPage, addPageHeaders, errorPage, forgotPasswordPage, phoneConfirmPage, resetCodePage } from '../interaction/templates.js'
import { type Notifier, NotifierUnavailableError } from '../notifications/notifier.js'

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
}

const PHONE_COOKIE = 'pforte_phone_step'
const PHONE_STEP_SECONDS = 30 * 60
interface PhoneStep {
  userId: string
  expiresAt: number
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const normalizeEmail = (value: unknown) => text(value).trim().toLowerCase()

const INVALID_LINK = 'This link is not valid any more. It may have been used already or have expired. Ask your administration for a new one.'
const BAD_CODE = 'The code is not correct or has expired. You can ask for a new one below.'

/** Pages that are not part of a sign-in: choosing the first password, and choosing a new one after forgetting it. */
export const accountRoutes =
  ({ db, sendPasswordResetCode, codeSecrets, notifier, cookieKeys, secure }: AccountDependencies) =>
  async (app: FastifyInstance) => {
    await app.register(formbody)
    addPageHeaders(app)

    const html = (reply: FastifyReply, status: number, body: string) => reply.code(status).type('text/html').send(body)
    const origin = (request: FastifyRequest) => ({ ip: request.ip, userAgent: request.headers['user-agent'] })

    /** The password and its repetition, checked against the policy. Returns what is wrong, if anything. */
    const passwordProblem = (body: Record<string, unknown> | undefined, email: string) => {
      const password = text(body?.password)
      if (password !== text(body?.confirm)) return 'The two passwords are not the same.'
      return checkPassword(password, email)
    }

    // --- First password, from the link in the activation e-mail

    app.get<{ Querystring: { token?: string } }>('/activate', async (request, reply) => {
      const token = text(request.query.token)
      const user = token ? await findPendingActivation(db, token) : undefined
      return user ? html(reply, 200, activationPage({ token })) : html(reply, 400, errorPage('Link not valid', INVALID_LINK))
    })

    app.post<{ Body: Record<string, unknown> }>('/activate', async (request, reply) => {
      const token = text(request.body?.token)
      const pending = token ? await findPendingActivation(db, token) : undefined
      if (!pending) return html(reply, 400, errorPage('Link not valid', INVALID_LINK))

      const problem = passwordProblem(request.body, pending.email)
      if (problem) return html(reply, 422, activationPage({ token, error: problem }))

      const user = await completeActivation(db, { token, passwordHash: await hash(text(request.body?.password)), ...origin(request) })
      if (!user) return html(reply, 400, errorPage('Link not valid', INVALID_LINK))

      // With SMS available, the number the back office entered is confirmed now, so that codes can go to it.
      if (notifier.smsAvailable && user.phone && !user.phoneVerifiedAt) {
        try {
          await sendPhoneCode(user)
          reply.header('Set-Cookie', phoneCookie(user.id))
          return html(reply, 200, phoneConfirmPage({ sentTo: maskPhone(user.phone) }))
        } catch (error) {
          if (!(error instanceof NotifierUnavailableError)) throw error
          request.log.error(error, 'the code to confirm the phone number could not be sent')
        }
      }
      return html(reply, 200, activeAccountPage)
    })

    const activeAccountPage = errorPage('Your account is active', 'Your password is set. You can now sign in from the application you came from.')

    const phoneCookie = (userId: string) =>
      setCookieHeader(PHONE_COOKIE, sign(cookieKeys, { userId, expiresAt: Date.now() + PHONE_STEP_SECONDS * 1000 } satisfies PhoneStep), {
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
      return user?.phone && !user.phoneVerifiedAt ? user : undefined
    }

    const finishedPhoneStep = (reply: FastifyReply, page: string) => {
      reply.header('Set-Cookie', setCookieHeader(PHONE_COOKIE, '', { path: '/activate', maxAgeSeconds: 0, secure }))
      return html(reply, 200, page)
    }

    app.post<{ Body: Record<string, unknown> }>('/activate/phone', async (request, reply) => {
      const user = await phoneStep(request)
      if (!user) return html(reply, 200, activeAccountPage)

      const code = text(request.body?.code).replaceAll(' ', '')
      const result = /^\d{6}$/.test(code) ? await checkCode(db, { userId: user.id, purpose: 'activation', code }, { secrets: codeSecrets }) : undefined
      if (!result?.ok) {
        return html(reply, 401, phoneConfirmPage({ sentTo: maskPhone(user.phone!), error: 'The code is not correct or has expired. You can ask for a new one below.' }))
      }
      await markPhoneVerified(db, user.id)
      return finishedPhoneStep(reply, errorPage('Phone number confirmed', 'Your account is active and your sign-in codes will come by SMS. You can now sign in from the application you came from.'))
    })

    app.post('/activate/phone/resend', async (request, reply) => {
      const user = await phoneStep(request)
      if (!user) return html(reply, 200, activeAccountPage)
      try {
        await sendPhoneCode(user)
      } catch (error) {
        if (error instanceof CodeLimitError) {
          return html(reply, 429, phoneConfirmPage({ sentTo: maskPhone(user.phone!), error: `Please wait ${error.retryAfterSeconds} seconds before asking for another code.` }))
        }
        if (!(error instanceof NotifierUnavailableError)) throw error
        request.log.error(error, 'the code to confirm the phone number could not be sent')
        return html(reply, 503, phoneConfirmPage({ sentTo: maskPhone(user.phone!), error: 'The code could not be sent. You can skip this step and confirm later.' }))
      }
      return html(reply, 200, phoneConfirmPage({ sentTo: maskPhone(user.phone!), notice: 'A new code is on its way.' }))
    })

    app.post('/activate/phone/skip', async (_request, reply) => finishedPhoneStep(reply, activeAccountPage))

    // --- Forgotten password

    app.get<{ Querystring: { email?: string } }>('/reset', async (request, reply) =>
      html(reply, 200, forgotPasswordPage({ email: normalizeEmail(request.query.email) })),
    )

    app.post<{ Body: Record<string, unknown> }>('/reset', async (request, reply) => {
      const email = normalizeEmail(request.body?.email)
      if (!email.includes('@')) return html(reply, 400, forgotPasswordPage({ email, error: 'Please enter your e-mail address.' }))

      // The answer is the same whether or not the address belongs to someone, so the page cannot be
      // used to find out who has an account.
      const user = await findUserByEmail(db, email)
      if (user?.status === 'active' && user.passwordHash) {
        try {
          await sendPasswordResetCode(user)
        } catch (error) {
          if (error instanceof NotifierUnavailableError) request.log.error(error, 'the password reset code could not be sent')
          else if (!(error instanceof CodeLimitError)) throw error
        }
      }
      return html(
        reply,
        200,
        resetCodePage({ email, notice: 'If there is an account for this address, we have sent a code to it. It is valid for 10 minutes.' }),
      )
    })

    app.get<{ Querystring: { email?: string } }>('/reset/code', async (request, reply) =>
      html(reply, 200, resetCodePage({ email: normalizeEmail(request.query.email) })),
    )

    app.post<{ Body: Record<string, unknown> }>('/reset/code', async (request, reply) => {
      const email = normalizeEmail(request.body?.email)
      // Before the code is looked at, so that a typo in the password does not use up an attempt.
      const problem = passwordProblem(request.body, email)
      if (problem) return html(reply, 422, resetCodePage({ email, error: problem }))

      const code = text(request.body?.code).replaceAll(' ', '')
      const user = await findUserByEmail(db, email)
      // One answer for every way this can fail, so it reveals nothing about the account.
      const refused = () => html(reply, 401, resetCodePage({ email, error: BAD_CODE }))
      if (!user || user.status !== 'active' || !user.passwordHash || !/^\d{6}$/.test(code)) return refused()

      const result = await checkCode(db, { userId: user.id, purpose: 'password_reset', code }, { secrets: codeSecrets })
      if (!result.ok) return refused()

      const changed = await completePasswordReset(db, { userId: user.id, passwordHash: await hash(text(request.body?.password)), ...origin(request) })
      if (!changed) return refused()
      if (result.channel === 'email') await markEmailVerified(db, user.id)
      return html(reply, 200, errorPage('Password changed', 'Your new password is set and you were signed out everywhere. Sign in again from your application.'))
    })
  }
