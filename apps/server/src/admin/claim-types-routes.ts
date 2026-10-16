import type { Database } from '@progwise/pforte-db'
import {
  ClaimsError,
  createClaimType,
  deleteClaimType,
  getClaimType,
  getClientClaimTypes,
  isValidPattern,
  listClaimTypesWithClients,
  setClientClaimTypes,
  updateClaimType,
} from '@progwise/pforte-db/admin'
import { findClientById } from '@progwise/pforte-db/oidc'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { AdminAuth } from './auth.js'
import { answeringClaimsErrors, sendClaimsError } from './claims-errors.js'
import { claimTypeKey } from './claims-routes.js'
import { problem, problemSchema } from './problem.js'
import { requestContext } from './users-routes.js'

const ERROR_RESPONSES = { 400: problemSchema, 401: problemSchema, 403: problemSchema, 404: problemSchema, 409: problemSchema }

const valuePattern = z
  .string()
  .max(200)
  .refine(isValidPattern, 'Not a valid regular expression')

const claimTypeSchema = z.object({
  key: z.string(),
  description: z.string(),
  valuePattern: z.string().nullable(),
  multiValued: z.boolean(),
  /** The clients that receive this claim type in their tokens. */
  clients: z.array(z.string()),
})

const isUniqueViolation = (error: unknown): boolean => {
  const candidate = error as { code?: string; cause?: unknown } | undefined
  return candidate?.code === '23505' || (candidate?.cause !== undefined && isUniqueViolation(candidate.cause))
}

export interface ClaimTypeDependencies {
  db: Database
  auth: AdminAuth
  /** Rebuilds the OpenID provider, which fixes its list of known claims when it is built. */
  reloadProvider: (request: FastifyRequest) => Promise<void>
}

/** Claim types, and which claim types each client receives. Changing the types needs the admin scope. */
export const claimTypesRoutes =
  ({ db, auth, reloadProvider }: ClaimTypeDependencies) =>
  async (instance: FastifyInstance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>()
    const readable = auth.require('directory', 'admin')
    const adminOnly = auth.require('admin')

    const asDto = async (key: string) => (await listClaimTypesWithClients(db)).find((type) => type.key === key)!
    const toDto = ({ key, description, valuePattern, multiValued, clients }: Awaited<ReturnType<typeof asDto>>) => ({
      key,
      description,
      valuePattern,
      multiValued,
      clients,
    })

    app.get(
      '/claim-types',
      {
        onRequest: readable,
        schema: {
          tags: ['Claim types'],
          summary: 'List claim types',
          response: { 200: z.object({ items: z.array(claimTypeSchema) }), ...ERROR_RESPONSES },
        },
      },
      async () => ({ items: (await listClaimTypesWithClients(db)).map(toDto) }),
    )

    app.post(
      '/claim-types',
      {
        onRequest: adminOnly,
        schema: {
          tags: ['Claim types'],
          summary: 'Create a claim type',
          description: 'The key is the claim name in tokens. Names that tokens already use (email, name, …) are reserved.',
          body: z.object({
            key: claimTypeKey,
            description: z.string().max(500).optional(),
            valuePattern: valuePattern.nullable().optional(),
            multiValued: z.boolean().optional(),
          }),
          response: { 201: claimTypeSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        try {
          const created = await db.transaction((tx) => createClaimType(tx, requestContext(request), request.body))
          await reloadProvider(request)
          return reply.code(201).header('Location', `/admin/claim-types/${created.key}`).send(toDto(await asDto(created.key)))
        } catch (error) {
          if (isUniqueViolation(error)) return problem(reply, 409, 'Conflict', 'A claim type with this key already exists.')
          if (error instanceof ClaimsError) return sendClaimsError(reply, error)
          throw error
        }
      },
    )

    app.patch(
      '/claim-types/:key',
      {
        onRequest: adminOnly,
        schema: {
          tags: ['Claim types'],
          summary: 'Change a claim type',
          description:
            'Refused with 409 when existing values would violate the change: a new pattern they do not match, or ' +
            'single-valued while a user holds several values.',
          params: z.object({ key: claimTypeKey }),
          body: z
            .object({
              description: z.string().max(500).optional(),
              valuePattern: valuePattern.nullable().optional(),
              multiValued: z.boolean().optional(),
            })
            .refine((body) => Object.keys(body).length > 0, 'Give at least one field to change'),
          response: { 200: claimTypeSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) =>
        answeringClaimsErrors(reply, async () => {
          const found = await db.transaction(async (tx) => {
            const claimType = await getClaimType(tx, request.params.key)
            if (!claimType) return false
            await updateClaimType(tx, requestContext(request), claimType, request.body)
            return true
          })
          return found ? toDto(await asDto(request.params.key)) : problem(reply, 404, 'Not found', 'There is no such claim type.')
        }),
    )

    app.delete(
      '/claim-types/:key',
      {
        onRequest: adminOnly,
        schema: {
          tags: ['Claim types'],
          summary: 'Delete a claim type',
          description:
            'Refused with 409 while users hold values of it. With `force=true` the values are deleted too, and the ' +
            'audit log records how many users and values were affected.',
          params: z.object({ key: claimTypeKey }),
          querystring: z.object({ force: z.enum(['true', 'false']).default('false') }),
          response: { 204: z.null(), ...ERROR_RESPONSES },
        },
      },
      async (request, reply) =>
        answeringClaimsErrors(reply, async () => {
          const found = await db.transaction(async (tx) => {
            const claimType = await getClaimType(tx, request.params.key)
            if (!claimType) return false
            await deleteClaimType(tx, requestContext(request), claimType, { force: request.query.force === 'true' })
            return true
          })
          if (!found) return problem(reply, 404, 'Not found', 'There is no such claim type.')
          await reloadProvider(request)
          return reply.code(204).send(null)
        }),
    )

    app.get(
      '/clients/:clientId/claim-types',
      {
        onRequest: adminOnly,
        schema: {
          tags: ['Claim types'],
          summary: 'The claim types a client receives',
          params: z.object({ clientId: z.string().min(1) }),
          response: { 200: z.object({ claimTypes: z.array(z.string()) }), ...ERROR_RESPONSES },
        },
      },
      async (request, reply) =>
        (await findClientById(db, request.params.clientId))
          ? { claimTypes: (await getClientClaimTypes(db, request.params.clientId)).sort() }
          : problem(reply, 404, 'Not found', 'There is no such client.'),
    )

    app.put(
      '/clients/:clientId/claim-types',
      {
        onRequest: adminOnly,
        schema: {
          tags: ['Claim types'],
          summary: 'Set the claim types a client receives',
          description: 'Replaces the whole set. A client only ever receives the claim types assigned to it.',
          params: z.object({ clientId: z.string().min(1) }),
          body: z.object({ claimTypes: z.array(claimTypeKey) }),
          response: { 200: z.object({ claimTypes: z.array(z.string()) }), ...ERROR_RESPONSES },
        },
      },
      async (request, reply) =>
        answeringClaimsErrors(reply, async () => {
          const result = await db.transaction((tx) =>
            setClientClaimTypes(tx, requestContext(request), request.params.clientId, request.body.claimTypes),
          )
          return { claimTypes: result.claimTypes }
        }),
    )
  }
