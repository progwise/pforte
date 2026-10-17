import type { Database } from '@progwise/pforte-db'
import { findUserById, listDevices, revokeAllDevices, revokeDevice } from '@progwise/pforte-db/admin'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { AdminAuth } from './auth.js'
import { problem, problemSchema } from './problem.js'
import { requestContext } from './users-routes.js'

const ERROR_RESPONSES = { 400: problemSchema, 401: problemSchema, 403: problemSchema, 404: problemSchema }

const deviceSchema = z.object({
  id: z.uuid(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  expiresAt: z.string(),
})

/** The devices a user has asked pforte to remember, so they are not asked for a code there. */
export const devicesRoutes =
  ({ db, auth }: { db: Database; auth: AdminAuth }) =>
  async (instance: FastifyInstance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>()
    const onRequest = auth.require('directory', 'admin')
    const noUser = (reply: Parameters<typeof problem>[0]) => problem(reply, 404, 'Not found', 'There is no such user.')

    app.get(
      '/users/:id/devices',
      {
        onRequest,
        schema: {
          tags: ['Devices'],
          summary: 'List the remembered devices of a user',
          description: 'Devices that skip the second factor: not revoked and not expired. Most recently seen first.',
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ items: z.array(deviceSchema) }), ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const user = await findUserById(db, request.params.id)
        if (!user) return noUser(reply)
        const items = await listDevices(db, user.id)
        return {
          items: items.map((device) => ({
            id: device.id,
            userAgent: device.userAgent,
            createdAt: device.createdAt.toISOString(),
            lastSeenAt: device.lastSeenAt.toISOString(),
            expiresAt: device.expiresAt.toISOString(),
          })),
        }
      },
    )

    app.delete(
      '/users/:id/devices/:deviceId',
      {
        onRequest,
        schema: {
          tags: ['Devices'],
          summary: 'Revoke a remembered device',
          description: 'The next sign-in on that device asks for the code again.',
          params: z.object({ id: z.uuid(), deviceId: z.uuid() }),
          response: { 204: z.null(), ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const result = await db.transaction(async (tx) => {
          const user = await findUserById(tx, request.params.id)
          if (!user) return 'no-user' as const
          return (await revokeDevice(tx, requestContext(request), user, request.params.deviceId)) ? 'revoked' : 'no-device'
        })
        if (result === 'no-user') return noUser(reply)
        if (result === 'no-device') return problem(reply, 404, 'Not found', 'The user has no such remembered device.')
        return reply.code(204).send(null)
      },
    )

    app.delete(
      '/users/:id/devices',
      {
        onRequest,
        schema: {
          tags: ['Devices'],
          summary: 'Revoke all remembered devices of a user',
          description: 'Every sign-in of the user asks for the code again. Locking, deactivating, resetting the password and ending sessions do this as well.',
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ devicesRevoked: z.number().int() }), ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const count = await db.transaction(async (tx) => {
          const user = await findUserById(tx, request.params.id)
          return user ? revokeAllDevices(tx, requestContext(request), user) : undefined
        })
        return count === undefined ? noUser(reply) : { devicesRevoked: count }
      },
    )
  }
