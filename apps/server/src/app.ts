import Fastify from 'fastify'
import { oidcRoutes } from './oidc/routes.js'
import type { ProviderHolder } from './oidc/provider.js'

export interface AppDependencies {
  /** Returns the current time as reported by the database. */
  getDatabaseTime: () => Promise<Date>
  /** The OpenID Connect provider. Omitted in tests that do not need it. */
  oidc?: Pick<ProviderHolder, 'handle' | 'issuer'>
}

export const buildApp = ({ getDatabaseTime, oidc }: AppDependencies) => {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' })

  app.get('/health', async (_request, reply) => {
    try {
      const databaseTime = await getDatabaseTime()
      return { status: 'ok', databaseTime: databaseTime.toISOString() }
    } catch (error) {
      app.log.error(error, 'health check failed')
      return reply.code(503).send({ status: 'error' })
    }
  })

  if (oidc) {
    void app.register(oidcRoutes(oidc))
  }

  return app
}
