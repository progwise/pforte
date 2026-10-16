import type { Database } from '@progwise/pforte-db'
import type { FastifyInstance } from 'fastify'
import { hasZodFastifySchemaValidationErrors, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import type { ProviderHolder } from '../oidc/provider.js'
import { createAdminAuth } from './auth.js'
import { problem } from './problem.js'
import { usersRoutes } from './users-routes.js'

export interface AdminDependencies {
  db: Database
  provider: Pick<ProviderHolder, 'current'>
}

/** The admin API, mounted under /admin. */
export const adminRoutes =
  ({ db, provider }: AdminDependencies) =>
  async (app: FastifyInstance) => {
    app.setValidatorCompiler(validatorCompiler)
    app.setSerializerCompiler(serializerCompiler)

    app.setErrorHandler((error, request, reply) => {
      if (hasZodFastifySchemaValidationErrors(error)) {
        return problem(reply, 400, 'Invalid request', 'The request does not match the schema.', {}, {
          errors: error.validation.map(({ instancePath, message }) => ({ path: instancePath, message })),
        })
      }
      request.log.error(error)
      return problem(reply, 500, 'Internal Server Error')
    })
    app.setNotFoundHandler((_request, reply) => problem(reply, 404, 'Not found'))

    const auth = createAdminAuth({ db, provider })
    await app.register(usersRoutes({ db, auth }))
  }
