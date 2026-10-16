import type { Database } from '@progwise/pforte-db'
import { addUserClaim, findUserById, getUserClaims, removeUserClaim, setUserClaims } from '@progwise/pforte-db/admin'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { AdminAuth } from './auth.js'
import { answeringClaimsErrors } from './claims-errors.js'
import { problem, problemSchema } from './problem.js'
import { requestContext } from './users-routes.js'

export const claimTypeKey = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'Use lowercase letters, digits and underscores, starting with a letter')
export const claimValues = z.record(claimTypeKey, z.array(z.string()))

const ERROR_RESPONSES = { 400: problemSchema, 401: problemSchema, 403: problemSchema, 404: problemSchema, 409: problemSchema }
const claimsResult = z.object({ changed: z.boolean(), claims: claimValues })

/** Claim values of a user: set (replace), add and remove. */
export const claimsRoutes =
  ({ db, auth }: { db: Database; auth: AdminAuth }) =>
  async (instance: FastifyInstance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>()
    const onRequest = auth.require('directory', 'admin')
    const params = z.object({ id: z.uuid() })
    const noUser = (reply: Parameters<typeof problem>[0]) => problem(reply, 404, 'Not found', 'There is no such user.')

    app.get(
      '/users/:id/claims',
      {
        onRequest,
        schema: {
          tags: ['Claims'],
          summary: 'The claim values of a user',
          params,
          response: { 200: z.object({ claims: claimValues }), ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const user = await findUserById(db, request.params.id)
        return user ? { claims: await getUserClaims(db, user.id) } : noUser(reply)
      },
    )

    app.put(
      '/users/:id/claims',
      {
        onRequest,
        schema: {
          tags: ['Claims'],
          summary: 'Set claims in bulk',
          description:
            'Replaces the values of exactly the claim types given and leaves every other claim of the user untouched. ' +
            'An empty list removes all values of a type. All values are checked first; if any is invalid nothing is changed.',
          params,
          body: z.object({ claims: claimValues }),
          response: { 200: claimsResult, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) =>
        answeringClaimsErrors(reply, () =>
          db.transaction(async (tx) => {
            const user = await findUserById(tx, request.params.id)
            return user ? setUserClaims(tx, requestContext(request), user, request.body.claims) : undefined
          }).then((result) => result ?? noUser(reply)),
        ),
    )

    app.put(
      '/users/:id/claims/:type',
      {
        onRequest,
        schema: {
          tags: ['Claims'],
          summary: 'Set the values of one claim type',
          params: z.object({ id: z.uuid(), type: claimTypeKey }),
          body: z.object({ values: z.array(z.string()) }),
          response: { 200: claimsResult, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) =>
        answeringClaimsErrors(reply, () =>
          db.transaction(async (tx) => {
            const user = await findUserById(tx, request.params.id)
            return user
              ? setUserClaims(tx, requestContext(request), user, { [request.params.type]: request.body.values })
              : undefined
          }).then((result) => result ?? noUser(reply)),
        ),
    )

    app.post(
      '/users/:id/claims/:type',
      {
        onRequest,
        schema: {
          tags: ['Claims'],
          summary: 'Add one value to a claim type',
          description: 'Does nothing if the user already has the value. A single-valued type refuses a second, different value.',
          params: z.object({ id: z.uuid(), type: claimTypeKey }),
          body: z.object({ value: z.string() }),
          response: { 200: claimsResult, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) =>
        answeringClaimsErrors(reply, () =>
          db.transaction(async (tx) => {
            const user = await findUserById(tx, request.params.id)
            return user ? addUserClaim(tx, requestContext(request), user, request.params.type, request.body.value) : undefined
          }).then((result) => result ?? noUser(reply)),
        ),
    )

    app.delete(
      '/users/:id/claims/:type/:value',
      {
        onRequest,
        schema: {
          tags: ['Claims'],
          summary: 'Remove one value of a claim type',
          description: 'Does nothing if the user does not have the value.',
          params: z.object({ id: z.uuid(), type: claimTypeKey, value: z.string().min(1) }),
          response: { 200: claimsResult, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) =>
        answeringClaimsErrors(reply, () =>
          db.transaction(async (tx) => {
            const user = await findUserById(tx, request.params.id)
            return user ? removeUserClaim(tx, requestContext(request), user, request.params.type, request.params.value) : undefined
          }).then((result) => result ?? noUser(reply)),
        ),
    )

  }
