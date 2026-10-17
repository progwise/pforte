import type { Database } from '@progwise/pforte-db'
import {
  activateUser,
  deactivateUser,
  endSessions,
  findUserById,
  LifecycleError,
  lockUser,
  requestPasswordReset,
  unlockUser,
} from '@progwise/pforte-db/admin'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { CodeLimitError } from '@progwise/pforte-db/codes'
import type { SendPasswordResetCode } from '../auth/password-reset.js'
import { type Notifier, NotifierUnavailableError } from '../notifications/notifier.js'
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

export interface LifecycleDependencies {
  db: Database
  auth: AdminAuth
  notifier: Notifier
  /** Sends the code for choosing a new password. */
  sendPasswordResetCode: SendPasswordResetCode
  /** The public address of pforte, used to build the activation link. */
  issuer: string
}

/** Lock, unlock, activate, deactivate, reset the password and end the sessions of a user. */
export const lifecycleRoutes =
  ({ db, auth, notifier, sendPasswordResetCode, issuer }: LifecycleDependencies) =>
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
          description: 'For a created or active user. Ends all their sessions and refresh tokens; they cannot sign in until unlocked.',
          params,
          response: { 200: userSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        try {
          const user = await db.transaction(async (tx) => {
            const found = await findUserById(tx, request.params.id)
            return found ? lockUser(tx, requestContext(request), found) : undefined
          })
          return user ? toUserDto(user) : noUser(reply)
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
          description: 'For a locked user. They become active again, or created if they never set a password.',
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
          return user ? toUserDto(user) : noUser(reply)
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
          description: 'For someone who has left. Ends all sessions and refresh tokens and cancels a pending activation link.',
          params,
          response: { 200: userSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        try {
          const user = await db.transaction(async (tx) => {
            const found = await findUserById(tx, request.params.id)
            return found ? deactivateUser(tx, requestContext(request), found) : undefined
          })
          return user ? toUserDto(user) : noUser(reply)
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
            'The link is never returned or logged by pforte.',
          params,
          response: {
            200: z.object({ user: userSchema, activation: z.object({ linkSent: z.boolean(), expiresAt: z.string().nullable() }) }),
            ...ERROR_RESPONSES,
          },
        },
      },
      async (request, reply) => {
        try {
          const result = await db.transaction(async (tx) => {
            const found = await findUserById(tx, request.params.id)
            return found ? activateUser(tx, requestContext(request), found) : undefined
          })
          if (!result) return noUser(reply)

          if (result.activation) {
            const url = `${issuer}/activate?token=${encodeURIComponent(result.activation.token)}`
            await notifier.sendActivationLink(asUser(result.user), { url, expiresAt: result.activation.expiresAt })
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
            'For an active user. Sends them a code to choose a new password and ends all their sessions and refresh ' +
            'tokens, since the account may be compromised.',
          params,
          response: { 200: userSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        try {
          const user = await db.transaction(async (tx) => {
            const found = await findUserById(tx, request.params.id)
            return found ? requestPasswordReset(tx, requestContext(request), found) : undefined
          })
          if (!user) return noUser(reply)
          await sendPasswordResetCode(user)
          return toUserDto(user)
        } catch (error) {
          if (error instanceof LifecycleError) return refused(reply, error)
          if (error instanceof CodeLimitError) {
            return problem(
              reply,
              429,
              'Too many requests',
              `${error.message} The change itself was saved; try again in ${error.retryAfterSeconds} seconds.`,
              { 'Retry-After': String(error.retryAfterSeconds) },
            )
          }
          if (error instanceof NotifierUnavailableError) return cannotSend(reply, error)
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
          description: 'Deletes their sessions, grants and refresh tokens and revokes their remembered devices, so they must sign in again, with a code. Their status does not change.',
          params,
          response: { 200: z.object({ sessionsEnded: z.number().int(), devicesRevoked: z.number().int() }), ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const result = await db.transaction(async (tx) => {
          const found = await findUserById(tx, request.params.id)
          return found ? endSessions(tx, requestContext(request), found) : undefined
        })
        return result ? { sessionsEnded: result.sessionsEnded, devicesRevoked: result.devicesRevoked } : noUser(reply)
      },
    )
  }
