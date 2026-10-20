import { hash } from '@node-rs/argon2'
import { randomBytes } from 'node:crypto'
import type { Database } from '@progwise/pforte-db'
import {
  APPLICATION_SCOPES,
  createClient,
  deleteClient,
  getClient,
  getClientClaimTypes,
  listClients,
  rotateClientSecret,
  updateClient,
} from '@progwise/pforte-db/admin'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { answeringAdminErrors } from './admin-errors.js'
import type { AdminAuth } from './auth.js'
import { isUniqueViolation } from './db-errors.js'
import { problem, problemSchema } from './problem.js'
import { requestContext } from './users-routes.js'

const ERROR_RESPONSES = { 400: problemSchema, 401: problemSchema, 403: problemSchema, 404: problemSchema, 409: problemSchema }

const clientId = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,62}$/, 'Use 3 to 63 lowercase letters, digits, dots, dashes or underscores')
const uris = z.array(z.string().max(2000)).max(50)

const clientSchema = z.object({
  /** Registered by pforte itself, such as the client of the administration UI; it cannot be changed or deleted. */
  system: z.boolean(),
  clientId: z.string(),
  name: z.string(),
  type: z.enum(['public', 'confidential']),
  redirectUris: z.array(z.string()),
  postLogoutRedirectUris: z.array(z.string()),
  backchannelLogoutUri: z.string().nullable(),
  backchannelLogoutSessionRequired: z.boolean(),
  allowedGrants: z.array(z.string()),
  scopes: z.array(z.string()),
  pkceRequired: z.boolean(),
  /** The claim types this client receives; set them with PUT /clients/{id}/claim-types. */
  claimTypes: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
})

type ClientRow = NonNullable<Awaited<ReturnType<typeof getClient>>>

/** The API's view of a client. The secret hash never leaves the database. */
const toClientDto = (client: ClientRow, claimTypes: string[]): z.infer<typeof clientSchema> => ({
  system: client.system,
  clientId: client.clientId,
  name: client.name,
  type: client.type,
  redirectUris: client.redirectUris,
  postLogoutRedirectUris: client.postLogoutRedirectUris,
  backchannelLogoutUri: client.backchannelLogoutUri,
  backchannelLogoutSessionRequired: client.backchannelLogoutSessionRequired,
  allowedGrants: client.allowedGrants,
  scopes: client.scopes,
  pkceRequired: client.pkceRequired,
  claimTypes: [...claimTypes].sort(),
  createdAt: client.createdAt.toISOString(),
  updatedAt: client.updatedAt.toISOString(),
})

const newSecret = () => randomBytes(32).toString('base64url')

export interface ClientRoutesDependencies {
  db: Database
  auth: AdminAuth
  /** Rebuilds the OpenID provider, which caches clients. */
  reloadProvider: (request: FastifyRequest) => Promise<void>
}

/** Registering, changing and removing the applications and machines that use pforte. Admin scope only. */
export const clientsRoutes =
  ({ db, auth, reloadProvider }: ClientRoutesDependencies) =>
  async (instance: FastifyInstance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>()
    const onRequest = auth.require('admin')
    const params = z.object({ clientId: z.string().min(1) })
    const noClient = (reply: FastifyReply) => problem(reply, 404, 'Not found', 'There is no such client.')

    const withClaimTypes = async (client: ClientRow) => toClientDto(client, await getClientClaimTypes(db, client.clientId))

    app.get(
      '/clients',
      {
        onRequest,
        schema: {
          tags: ['Clients'],
          summary: 'List clients',
          response: { 200: z.object({ items: z.array(clientSchema) }), ...ERROR_RESPONSES },
        },
      },
      async () => ({ items: (await listClients(db)).map(({ claimTypes, ...client }) => toClientDto(client, claimTypes)) }),
    )

    app.get(
      '/clients/:clientId',
      {
        onRequest,
        schema: {
          tags: ['Clients'],
          summary: 'Get a client',
          params,
          response: { 200: clientSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const client = await getClient(db, request.params.clientId)
        return client ? withClaimTypes(client) : noClient(reply)
      },
    )

    app.post(
      '/clients',
      {
        onRequest,
        schema: {
          tags: ['Clients'],
          summary: 'Register a client',
          description:
            'Two kinds exist. An **application** signs users in (authorization code flow, public or confidential) and has ' +
            'OpenID scopes and redirect URIs. A **machine** calls the admin API with the client_credentials grant and has ' +
            'only the scopes `admin` and/or `directory`. They never mix. A confidential client gets a generated secret, ' +
            'returned here once and never again. Redirect URIs must be https (http only for localhost).',
          body: z.object({
            clientId,
            name: z.string().trim().min(1).max(200),
            type: z.enum(['public', 'confidential']),
            redirectUris: uris.optional(),
            postLogoutRedirectUris: uris.optional(),
            backchannelLogoutUri: z.string().max(2000).nullable().optional(),
            backchannelLogoutSessionRequired: z.boolean().optional(),
            allowedGrants: z.array(z.string()).optional(),
            scopes: z.array(z.string()).optional(),
            pkceRequired: z.boolean().optional(),
          }),
          response: { 201: z.object({ client: clientSchema, clientSecret: z.string().nullable() }), ...ERROR_RESPONSES },
        },
      },
      async (request, reply) =>
        answeringAdminErrors(reply, async () => {
          const body = request.body
          const allowedGrants = body.allowedGrants ?? ['authorization_code', 'refresh_token']
          const machine = allowedGrants.includes('client_credentials')
          const secret = body.type === 'confidential' ? newSecret() : null

          try {
            const created = await db.transaction(async (tx) =>
              createClient(tx, requestContext(request), {
                clientId: body.clientId,
                name: body.name,
                type: body.type,
                secretHash: secret ? await hash(secret) : undefined,
                redirectUris: body.redirectUris ?? [],
                postLogoutRedirectUris: body.postLogoutRedirectUris ?? [],
                backchannelLogoutUri: body.backchannelLogoutUri ?? null,
                backchannelLogoutSessionRequired: body.backchannelLogoutSessionRequired ?? false,
                allowedGrants,
                scopes: body.scopes ?? (machine ? [] : [...APPLICATION_SCOPES]),
                pkceRequired: body.pkceRequired ?? true,
              }),
            )
            await reloadProvider(request)
            return reply
              .code(201)
              .header('Location', `/admin/clients/${created.clientId}`)
              .send({ client: toClientDto(created, []), clientSecret: secret })
          } catch (error) {
            if (isUniqueViolation(error)) return problem(reply, 409, 'Conflict', 'A client with this id already exists.')
            throw error
          }
        }),
    )

    app.patch(
      '/clients/:clientId',
      {
        onRequest,
        schema: {
          tags: ['Clients'],
          summary: 'Change a client',
          description:
            'Only the fields given are changed, and the result must still be a valid client of its kind. Takes effect at ' +
            'once. The last client with the `admin` scope cannot lose it.',
          params,
          body: z
            .object({
              name: z.string().trim().min(1).max(200).optional(),
              redirectUris: uris.optional(),
              postLogoutRedirectUris: uris.optional(),
              backchannelLogoutUri: z.string().max(2000).nullable().optional(),
              backchannelLogoutSessionRequired: z.boolean().optional(),
              allowedGrants: z.array(z.string()).optional(),
              scopes: z.array(z.string()).optional(),
              pkceRequired: z.boolean().optional(),
            })
            .refine((body) => Object.keys(body).length > 0, 'Give at least one field to change'),
          response: { 200: clientSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) =>
        answeringAdminErrors(reply, async () => {
          const found = await db.transaction(async (tx) => {
            const client = await getClient(tx, request.params.clientId)
            if (!client) return undefined
            await updateClient(tx, requestContext(request), client, request.body)
            return client.clientId
          })
          if (!found) return noClient(reply)
          await reloadProvider(request)
          return withClaimTypes((await getClient(db, found))!)
        }),
    )

    app.post(
      '/clients/:clientId/rotate-secret',
      {
        onRequest,
        schema: {
          tags: ['Clients'],
          summary: 'Replace the secret of a confidential client',
          description: 'The old secret stops working at once. The new one is returned here once and never again.',
          params,
          response: { 200: z.object({ clientSecret: z.string() }), ...ERROR_RESPONSES },
        },
      },
      async (request, reply) =>
        answeringAdminErrors(reply, async () => {
          const secret = newSecret()
          const secretHash = await hash(secret)
          const found = await db.transaction(async (tx) => {
            const client = await getClient(tx, request.params.clientId)
            if (!client) return false
            await rotateClientSecret(tx, requestContext(request), client, secretHash)
            return true
          })
          if (!found) return noClient(reply)
          await reloadProvider(request)
          return { clientSecret: secret }
        }),
    )

    app.delete(
      '/clients/:clientId',
      {
        onRequest,
        schema: {
          tags: ['Clients'],
          summary: 'Delete a client',
          description:
            'Also removes its claim type assignments and revokes every grant and token issued to it. Refused for the ' +
            'last client with the `admin` scope and for the client making the call.',
          params,
          response: { 204: z.null(), ...ERROR_RESPONSES },
        },
      },
      async (request, reply) =>
        answeringAdminErrors(reply, async () => {
          const found = await db.transaction(async (tx) => {
            const client = await getClient(tx, request.params.clientId)
            if (!client) return false
            await deleteClient(tx, requestContext(request), client)
            return true
          })
          if (!found) return noClient(reply)
          await reloadProvider(request)
          return reply.code(204).send(null)
        }),
    )
  }
