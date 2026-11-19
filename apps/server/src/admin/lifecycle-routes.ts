import type { Database } from '@progwise/pforte-db'
import {
  activateUser,
  confirmPhone,
  deactivateUser,
  endSessions,
  findUserById,
  getClient,
  LifecycleError,
  lockUser,
  phoneToConfirm,
  recordPhoneCodeSent,
  requestPasswordReset,
  unlockUser,
} from '@progwise/pforte-db/admin'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { CodeLimitError, issueCode, withdrawCode } from '@progwise/pforte-db/codes'
import { maskPhone } from '../auth/channels.js'
import type { SendPasswordResetCode } from '../auth/password-reset.js'
import type { RateLimiter } from '../auth/rate-limiter.js'
import { type Notifier, NotifierUnavailableError } from '../notifications/notifier.js'
import type { ClientLogouts } from '../oidc/client-logouts.js'
import type { AdminAuth } from './auth.js'
import { problem, problemSchema } from './problem.js'
import { requestContext, toUserDto, userSchema } from './users-routes.js'

const ERROR_RESPONSES = {
  400: problemSchema,
  401: problemSchema,
  403: problemSchema,
  404: problemSchema,
  409: problemSchema,
  429: problemSchema,
  503: problemSchema,
}

/** A wait as the detail of a problem says it, in English as all of the API: "1 second", "42 seconds". */
const seconds = (count: number) => `${count} second${count === 1 ? '' : 's'}`

export interface LifecycleDependencies {
  db: Database
  auth: AdminAuth
  notifier: Notifier
  /** Sends the code for choosing a new password. */
  sendPasswordResetCode: SendPasswordResetCode
  /** Forgets the failed sign-in attempts of a user who is unlocked. */
  limiter: RateLimiter
  /** The public address of pforte, used to build the activation link. */
  issuer: string
  /** How long an activation link works; seven days if not given. */
  activationValidityMs?: number
  /** Tells the applications of a user whose sessions were ended. */
  clientLogouts: ClientLogouts
  /** The secrets that sign one-time codes (see `deriveCodeSecrets`). */
  codeSecrets: string[]
}

/** Lock, unlock, activate, deactivate, reset the password and end the sessions of a user. */
export const lifecycleRoutes =
  ({ db, auth, notifier, sendPasswordResetCode, limiter, issuer, activationValidityMs, clientLogouts, codeSecrets }: LifecycleDependencies) =>
  async (instance: FastifyInstance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>()
    const onRequest = auth.require('directory', 'admin')
    const params = z.object({ id: z.uuid() })

    const noUser = (reply: FastifyReply) => problem(reply, 404, 'Not found', 'There is no such user.')
    const refused = (reply: FastifyReply, error: LifecycleError) => problem(reply, 409, 'Conflict', error.message)
    const cannotSend = (reply: FastifyReply, error: NotifierUnavailableError) =>
      problem(
        reply,
        503,
        'Cannot send the message',
        `${error.message} The change itself was saved; repeat the call once messages can be sent.`,
      )

    const asUser = (user: Parameters<typeof toUserDto>[0]) => ({ id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, language: user.language, phone: user.phone })

    app.post(
      '/users/:id/lock',
      {
        onRequest,
        schema: {
          tags: ['Lifecycle'],
          summary: 'Lock a user',
          description: 'For a created or active user. Ends all their sessions and refresh tokens and tells their applications (back-channel logout); they cannot sign in until unlocked.',
          params,
          response: { 200: userSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        try {
          const locked = await db.transaction(async (tx) => {
            const found = await findUserById(tx, request.params.id)
            return found ? lockUser(tx, requestContext(request), found) : undefined
          })
          if (!locked) return noUser(reply)
          clientLogouts.send(locked.user, locked.logouts)
          return toUserDto(locked.user)
        } catch (error) {
          if (error instanceof LifecycleError) return refused(reply, error)
          throw error
        }
      },
    )

    app.post(
      '/users/:id/unlock',
      {
        onRequest,
        schema: {
          tags: ['Lifecycle'],
          summary: 'Unlock a user',
          description:
            'For a locked user: they become active again, or created if they never set a password. For an active user, who is not ' +
            'locked, nothing changes except that the failed sign-in attempts held against their address are forgotten, so they can ' +
            'try again at once after too many mistakes.',
          params,
          response: { 200: userSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        try {
          const user = await db.transaction(async (tx) => {
            const found = await findUserById(tx, request.params.id)
            return found ? unlockUser(tx, requestContext(request), found) : undefined
          })
          if (!user) return noUser(reply)
          await limiter.forgetAddress(user.email)
          return toUserDto(user)
        } catch (error) {
          if (error instanceof LifecycleError) return refused(reply, error)
          throw error
        }
      },
    )

    app.post(
      '/users/:id/deactivate',
      {
        onRequest,
        schema: {
          tags: ['Lifecycle'],
          summary: 'Deactivate a user',
          description: 'For someone who has left. Ends all sessions and refresh tokens, tells their applications (back-channel logout) and cancels a pending activation link.',
          params,
          response: { 200: userSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        try {
          const deactivated = await db.transaction(async (tx) => {
            const found = await findUserById(tx, request.params.id)
            return found ? deactivateUser(tx, requestContext(request), found) : undefined
          })
          if (!deactivated) return noUser(reply)
          clientLogouts.send(deactivated.user, deactivated.logouts)
          return toUserDto(deactivated.user)
        } catch (error) {
          if (error instanceof LifecycleError) return refused(reply, error)
          throw error
        }
      },
    )

    app.post(
      '/users/:id/activate',
      {
        onRequest,
        schema: {
          tags: ['Lifecycle'],
          summary: 'Activate a user',
          description:
            'For a created user: sends the activation link, where they choose their first password; a new call replaces ' +
            'the earlier link. For a deactivated user who already has a password: makes them active again, without a link. ' +
            'The link is never returned or logged by pforte. The body is optional; with `clientId` (a registered client) the e-mail names the ' +
            'application and the page after choosing the password leads to its start address (`clientUri`); an unknown ' +
            'client is a 400.',
          params,
          body: z.object({ clientId: z.string().min(1).max(63).optional() }).nullish(),
          response: {
            200: z.object({ user: userSchema, activation: z.object({ linkSent: z.boolean(), expiresAt: z.string().nullable() }) }),
            ...ERROR_RESPONSES,
          },
        },
      },
      async (request, reply) => {
        try {
          const clientId = request.body?.clientId
          const client = clientId ? await getClient(db, clientId) : undefined
          if (clientId && !client) return problem(reply, 400, 'Invalid request', `There is no client "${clientId}".`)
          const result = await db.transaction(async (tx) => {
            const found = await findUserById(tx, request.params.id)
            return found ? activateUser(tx, requestContext(request), found, { clientId: client?.clientId, validityMs: activationValidityMs }) : undefined
          })
          if (!result) return noUser(reply)

          if (result.activation) {
            const url = `${issuer}/activate?token=${encodeURIComponent(result.activation.token)}`
            await notifier.sendActivationLink(asUser(result.user), { url, expiresAt: result.activation.expiresAt, applicationName: client?.name })
          }
          return {
            user: toUserDto(result.user),
            activation: { linkSent: Boolean(result.activation), expiresAt: result.activation?.expiresAt.toISOString() ?? null },
          }
        } catch (error) {
          if (error instanceof LifecycleError) return refused(reply, error)
          if (error instanceof NotifierUnavailableError) return cannotSend(reply, error)
          throw error
        }
      },
    )

    app.post(
      '/users/:id/reset-password',
      {
        onRequest,
        schema: {
          tags: ['Lifecycle'],
          summary: 'Reset the password of a user',
          description:
            'For an active user. Sends them a code to choose a new password, ends all their sessions and refresh ' +
            'tokens and tells their applications (back-channel logout), since the account may be compromised. The body is ' +
            'optional; with `clientId` (a registered client) the page after choosing the new password leads to its start ' +
            'address (`clientUri`); an unknown client is a 400.',
          params,
          body: z.object({ clientId: z.string().min(1).max(63).optional() }).nullish(),
          response: { 200: userSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        try {
          const clientId = request.body?.clientId
          const client = clientId ? await getClient(db, clientId) : undefined
          if (clientId && !client) return problem(reply, 400, 'Invalid request', `There is no client "${clientId}".`)
          const reset = await db.transaction(async (tx) => {
            const found = await findUserById(tx, request.params.id)
            return found ? requestPasswordReset(tx, requestContext(request), found) : undefined
          })
          if (!reset) return noUser(reply)
          const { user } = reset
          // Before the code is sent: the sessions are gone whether or not the mail can go out.
          clientLogouts.send(user, reset.logouts)
          await sendPasswordResetCode(user, { clientId: client?.clientId })
          return toUserDto(user)
        } catch (error) {
          if (error instanceof LifecycleError) return refused(reply, error)
          if (error instanceof CodeLimitError) {
            return problem(
              reply,
              429,
              'Too many requests',
              `${error.message} The change itself was saved; try again in ${seconds(error.retryAfterSeconds)}.`,
              { 'Retry-After': String(error.retryAfterSeconds) },
            )
          }
          if (error instanceof NotifierUnavailableError) return cannotSend(reply, error)
          throw error
        }
      },
    )

    // --- Confirming a phone number from an application: it shows the field for the code, pforte sends and checks it

    const PHONE_NOTE =
      'For an application that lets a person confirm their phone number in its own pages, so that their sign-in codes go by SMS. ' +
      'Call it only for the person who is signed in to your application, and only when they asked for it: the code shows that whoever ' +
      'typed it holds the phone, and your application vouches that this is the person the account belongs to.'

    app.post(
      '/users/:id/send-phone-code',
      {
        onRequest,
        schema: {
          tags: ['Lifecycle'],
          summary: 'Send the code that confirms the phone number of a user',
          description:
            'For an active user with a phone number that is not confirmed (`phoneVerifiedAt` is null). pforte sends a 6-digit code by SMS to ' +
            'the stored number; it is never returned. It is valid for ten minutes and for that number only, and a new one replaces it. ' +
            'A user gets at most one code a minute and five an hour (429 with `Retry-After`). 409 when there is nothing to confirm, or when ' +
            `this pforte sends no SMS. ${PHONE_NOTE}`,
          params,
          response: { 200: z.object({ sentTo: z.string(), expiresAt: z.string() }), ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const user = await findUserById(db, request.params.id)
        if (!user) return noUser(reply)
        if (!notifier.smsAvailable) return problem(reply, 409, 'Conflict', 'This pforte sends no SMS, so there is nothing a phone number is confirmed for.')
        try {
          const phone = phoneToConfirm(user)
          // Bound to the number it goes to: it confirms that number and no other.
          const { code, expiresAt } = await issueCode(db, { userId: user.id, channel: 'sms', purpose: 'activation', boundTo: phone }, { secrets: codeSecrets })
          try {
            await notifier.sendPhoneCode(asUser(user), { code, expiresAt })
          } catch (error) {
            // Nobody is waiting for that code.
            await withdrawCode(db, { userId: user.id, purpose: 'activation' })
            throw error
          }
          await recordPhoneCodeSent(db, requestContext(request), user, expiresAt)
          return { sentTo: maskPhone(phone), expiresAt: expiresAt.toISOString() }
        } catch (error) {
          if (error instanceof LifecycleError) return refused(reply, error)
          if (error instanceof CodeLimitError) {
            return problem(reply, 429, 'Too many requests', `${error.message} Try again in ${seconds(error.retryAfterSeconds)}.`, { 'Retry-After': String(error.retryAfterSeconds) })
          }
          if (error instanceof NotifierUnavailableError) return problem(reply, 503, 'Cannot send the message', `${error.message} No code was sent; repeat the call once messages can be sent.`)
          throw error
        }
      },
    )

    app.post(
      '/users/:id/confirm-phone',
      {
        onRequest,
        schema: {
          tags: ['Lifecycle'],
          summary: 'Confirm the phone number of a user with the code they received',
          description:
            'Checks the code that `send-phone-code` sent. If it is right, the number is confirmed (`phoneVerifiedAt`) and the sign-in codes of ' +
            'the user go by SMS from now on. 422 for a code that is wrong, has expired or was tried too often (five attempts per code): send a ' +
            `new one. 409 when there is nothing to confirm. ${PHONE_NOTE}`,
          params,
          body: z.object({ code: z.string().min(1).max(20) }),
          response: { 200: userSchema, ...ERROR_RESPONSES, 422: problemSchema },
        },
      },
      async (request, reply) => {
        try {
          // One step, with the person's row held: whether there is something to confirm, the check of the code,
          // the confirmation, and the row this answer is made from.
          const result = await confirmPhone(db, requestContext(request), { userId: request.params.id, code: request.body.code }, { secrets: codeSecrets })
          if (!result) return noUser(reply)
          if (!result.ok) return problem(reply, 422, 'Wrong code', 'The code is not correct, has expired or was tried too often. Send a new one.')
          return toUserDto(result.user)
        } catch (error) {
          if (error instanceof LifecycleError) return refused(reply, error)
          throw error
        }
      },
    )

    app.post(
      '/users/:id/end-sessions',
      {
        onRequest,
        schema: {
          tags: ['Lifecycle'],
          summary: 'End all sessions of a user',
          description: 'Deletes their sessions, grants and refresh tokens, revokes their remembered devices and tells their applications (back-channel logout), so they must sign in again, with a code. Their status does not change.',
          params,
          response: { 200: z.object({ sessionsEnded: z.number().int(), devicesRevoked: z.number().int() }), ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const result = await db.transaction(async (tx) => {
          const found = await findUserById(tx, request.params.id)
          return found ? endSessions(tx, requestContext(request), found) : undefined
        })
        if (!result) return noUser(reply)
        clientLogouts.send(result.user, result.logouts)
        return { sessionsEnded: result.sessionsEnded, devicesRevoked: result.devicesRevoked }
      },
    )
  }
