import formbody from '@fastify/formbody'
import { hash } from '@node-rs/argon2'
import type { Database } from '@progwise/pforte-db'
import { checkCode, CodeLimitError, markEmailVerified } from '@progwise/pforte-db/codes'
import { completeActivation, completePasswordReset, findPendingActivation } from '@progwise/pforte-db/credentials'
import { findUserByEmail } from '@progwise/pforte-db/users'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { checkPassword } from '../auth/password-policy.js'
import type { SendPasswordResetCode } from '../auth/password-reset.js'
import { NotifierUnavailableError } from '../notifications/notifier.js'
import { activationPage, addPageHeaders, errorPage, forgotPasswordPage, resetCodePage } from '../interaction/templates.js'

export interface AccountDependencies {
  db: Database
  sendPasswordResetCode: SendPasswordResetCode
  /** The secrets that sign one-time codes (see `deriveCodeSecrets`). */
  codeSecrets: string[]
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const normalizeEmail = (value: unknown) => text(value).trim().toLowerCase()

const INVALID_LINK = 'This link is not valid any more. It may have been used already or have expired. Ask your administration for a new one.'
const BAD_CODE = 'The code is not correct or has expired. You can ask for a new one below.'

/** Pages that are not part of a sign-in: choosing the first password, and choosing a new one after forgetting it. */
export const accountRoutes =
  ({ db, sendPasswordResetCode, codeSecrets }: AccountDependencies) =>
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
      return html(reply, 200, errorPage('Your account is active', 'Your password is set. You can now sign in from the application you came from.'))
    })

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
