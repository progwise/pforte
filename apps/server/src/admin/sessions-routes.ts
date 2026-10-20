import type { Database } from '@progwise/pforte-db'
import { findUserById, listClients, listUserSessions } from '@progwise/pforte-db/admin'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { AdminAuth } from './auth.js'
import { problem, problemSchema } from './problem.js'

const ERROR_RESPONSES = { 400: problemSchema, 401: problemSchema, 403: problemSchema, 404: problemSchema, 429: problemSchema }

const application = z.object({ clientId: z.string(), name: z.string() })

/** Where a user is signed in. */
export const sessionsRoutes =
  ({ db, auth }: { db: Database; auth: AdminAuth }) =>
  async (instance: FastifyInstance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>()

    app.get(
      '/users/:id/sessions',
      {
        onRequest: auth.require('directory', 'admin'),
        schema: {
          tags: ['Lifecycle'],
          summary: 'Where a user is signed in',
          description:
            'The browser sessions (single sign-on) that are open, and the applications that were granted access and stay signed in, ' +
            'such as an app on a phone. Identifiers and tokens are not returned. `POST /users/{id}/end-sessions` ends them all.',
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({
              sessions: z.array(
                z.object({
                  startedAt: z.string(),
                  expiresAt: z.string().nullable(),
                  /** `urn:pforte:acr:mfa` when a code was entered, `urn:pforte:acr:pwd` for the password only. */
                  acr: z.string().nullable(),
                  applications: z.array(application),
                }),
              ),
              grants: z.array(application.extend({ since: z.string(), expiresAt: z.string().nullable() })),
            }),
            ...ERROR_RESPONSES,
          },
        },
      },
      async (request, reply) => {
        const user = await findUserById(db, request.params.id)
        if (!user) return problem(reply, 404, 'Not found', 'There is no such user.')

        const names = new Map((await listClients(db)).map((client) => [client.clientId, client.name]))
        const named = (clientId: string) => ({ clientId, name: names.get(clientId) ?? clientId })
        const { sessions, grants } = await listUserSessions(db, user.id)
        return {
          sessions: sessions.map((session) => ({
            startedAt: session.startedAt.toISOString(),
            expiresAt: session.expiresAt?.toISOString() ?? null,
            acr: session.acr,
            applications: session.clientIds.map(named),
          })),
          grants: grants.map((grant) => ({ ...named(grant.clientId), since: grant.since.toISOString(), expiresAt: grant.expiresAt?.toISOString() ?? null })),
        }
      },
    )
  }
