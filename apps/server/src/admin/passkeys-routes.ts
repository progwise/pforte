import type { Database } from '@progwise/pforte-db'
import { findUserById, listPasskeys, removePasskey } from '@progwise/pforte-db/admin'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { AdminAuth } from './auth.js'
import { problem, problemSchema } from './problem.js'
import { requestContext } from './users-routes.js'

const ERROR_RESPONSES = { 400: problemSchema, 401: problemSchema, 403: problemSchema, 404: problemSchema }

const passkeySchema = z.object({
  id: z.uuid(),
  /** The browser and system the passkey was created with, such as "Safari, iPhone". */
  label: z.string().nullable(),
  /** Whether it is synced to the person's other devices. */
  synced: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
})

/** The passkeys of a user: seeing them, and removing one. Creating one is the person's own doing, on their device. */
export const passkeysRoutes =
  ({ db, auth }: { db: Database; auth: AdminAuth }) =>
  async (instance: FastifyInstance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>()
    const onRequest = auth.require('directory', 'admin')
    const noUser = (reply: Parameters<typeof problem>[0]) => problem(reply, 404, 'Not found', 'There is no such user.')

    app.get(
      '/users/:id/passkeys',
      {
        onRequest,
        schema: {
          tags: ['Passkeys'],
          summary: 'List the passkeys of a user',
          description: 'Newest first. Neither the id a device knows a passkey by nor its public key is returned.',
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ items: z.array(passkeySchema) }), ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const user = await findUserById(db, request.params.id)
        if (!user) return noUser(reply)
        const items = await listPasskeys(db, user.id)
        return {
          items: items.map((passkey) => ({
            id: passkey.id,
            label: passkey.label,
            synced: passkey.synced,
            createdAt: passkey.createdAt.toISOString(),
            lastUsedAt: passkey.lastUsedAt?.toISOString() ?? null,
          })),
        }
      },
    )

    app.delete(
      '/users/:id/passkeys/:passkeyId',
      {
        onRequest,
        schema: {
          tags: ['Passkeys'],
          summary: 'Remove a passkey',
          description:
            'The passkey cannot sign in any more. Sessions are not ended: use `POST /users/{id}/end-sessions` for that. ' +
            'The device of the person may still list the passkey; pforte cannot delete it there.',
          params: z.object({ id: z.uuid(), passkeyId: z.uuid() }),
          response: { 204: z.null(), ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const result = await db.transaction(async (tx) => {
          const user = await findUserById(tx, request.params.id)
          if (!user) return 'no-user' as const
          return (await removePasskey(tx, requestContext(request), user, request.params.passkeyId)) ? 'removed' : 'no-passkey'
        })
        if (result === 'no-user') return noUser(reply)
        if (result === 'no-passkey') return problem(reply, 404, 'Not found', 'The user has no such passkey.')
        return reply.code(204).send(null)
      },
    )
  }
