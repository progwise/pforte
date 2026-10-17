import swagger from '@fastify/swagger'
import type { Database } from '@progwise/pforte-db'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod'
import type { Notifier } from '../notifications/notifier.js'
import type { ProviderHolder } from '../oidc/provider.js'
import { createAdminAuth } from './auth.js'
import { auditRoutes } from './audit-routes.js'
import { claimTypesRoutes } from './claim-types-routes.js'
import { clientsRoutes } from './clients-routes.js'
import { devicesRoutes } from './devices-routes.js'
import { claimsRoutes } from './claims-routes.js'
import { lifecycleRoutes } from './lifecycle-routes.js'
import { problem } from './problem.js'
import { usersRoutes } from './users-routes.js'

export interface AdminDependencies {
  db: Database
  provider: Pick<ProviderHolder, 'current' | 'reload' | 'issuer'>
  /** Sends activation links and password reset codes. */
  notifier: Notifier
}

/** The admin API, mounted under /admin. */
export const adminRoutes =
  ({ db, provider, notifier }: AdminDependencies) =>
  async (app: FastifyInstance) => {
    app.setValidatorCompiler(validatorCompiler)
    app.setSerializerCompiler(serializerCompiler)

    // The OpenAPI document is generated from the route schemas, so it cannot drift from the code.
    await app.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title: 'pforte admin API',
          version: '0.0.0',
          description:
            'Manage users, claims, clients and the audit log of a pforte identity service. Authenticate with an access ' +
            'token from the OAuth `client_credentials` grant of a client registered with the scope `admin` (everything) ' +
            'or `directory` (users and claims only). Errors are RFC 9457 `application/problem+json` documents.',
        },
        servers: [{ url: provider.issuer }],
        tags: [
          { name: 'Users', description: 'Create, find, change and delete users; idempotent upsert by e-mail for imports.' },
          { name: 'Lifecycle', description: 'Lock, unlock, activate, deactivate, reset the password and end the sessions of a user.' },
          { name: 'Devices', description: 'The devices a user asked pforte to remember, so they skip the second factor there.' },
          { name: 'Claims', description: 'The claim values of a user.' },
          { name: 'Claim types', description: 'The kinds of claims, and which clients receive them.' },
          { name: 'Clients', description: 'The applications and machines that use pforte.' },
          { name: 'Audit', description: 'Who did what, when and to whom.' },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              description: 'Access token from the client_credentials grant (POST /token) of an admin client.',
            },
          },
        },
        security: [{ bearerAuth: [] }],
      },
      transform: jsonSchemaTransform,
    })

    app.setErrorHandler((error, request, reply) => {
      if (hasZodFastifySchemaValidationErrors(error)) {
        return problem(reply, 400, 'Invalid request', 'The request does not match the schema.', {}, {
          errors: error.validation.map(({ instancePath, message }) => ({ path: instancePath, message })),
        })
      }
      // Errors of the caller (bad JSON, wrong content type, …) keep their own 4xx status.
      const status = (error as { statusCode?: number }).statusCode
      if (status && status >= 400 && status < 500) {
        return problem(reply, status, status === 415 ? 'Unsupported media type' : 'Bad request', (error as Error).message)
      }
      request.log.error(error)
      return problem(reply, 500, 'Internal Server Error')
    })

    // Many HTTP clients send Content-Type: application/json even on a DELETE without a body, which
    // Fastify refuses as an empty JSON body. A request that carries no body has no content type.
    app.addHook('onRequest', async (request) => {
      const { headers } = request
      const noBody = headers['transfer-encoding'] === undefined && (headers['content-length'] ?? '0') === '0'
      if (noBody) delete headers['content-type']
    })
    app.setNotFoundHandler((_request, reply) => problem(reply, 404, 'Not found'))

    const auth = createAdminAuth({ db, provider })
    // The change is already committed when the provider is rebuilt, so a failed rebuild is logged,
    // not reported as a failed request. The next restart picks the claim types up anyway.
    const reloadProvider = async (request: FastifyRequest) => {
      try {
        await provider.reload()
      } catch (error) {
        request.log.error(error, 'rebuilding the OpenID provider after a claim type change failed')
      }
    }

    await app.register(usersRoutes({ db, auth }))
    await app.register(claimsRoutes({ db, auth }))
    await app.register(devicesRoutes({ db, auth }))
    await app.register(lifecycleRoutes({ db, auth, notifier, issuer: provider.issuer }))
    await app.register(claimTypesRoutes({ db, auth, reloadProvider }))
    await app.register(clientsRoutes({ db, auth, reloadProvider }))
    await app.register(auditRoutes({ db, auth }))

    app.get(
      '/openapi.json',
      { onRequest: auth.require('directory', 'admin'), schema: { hide: true } },
      async () => app.swagger(),
    )
  }
