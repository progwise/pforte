import Fastify from 'fastify'
import { type AdminDependencies, adminRoutes } from './admin/index.js'
import type { InteractionDependencies } from './interaction/routes.js'
import { interactionRoutes } from './interaction/routes.js'
import { oidcRoutes } from './oidc/routes.js'
import type { ProviderHolder } from './oidc/provider.js'

export interface AppDependencies {
  /** The admin API. Needs the provider (to verify tokens) and the database. */
  admin?: AdminDependencies
  /** Returns the current time as reported by the database. */
  getDatabaseTime: () => Promise<Date>
  /** The OpenID Connect provider and its login. Omitted in tests that do not need them. */
  oidc?: Omit<InteractionDependencies, 'provider'> & {
    provider: Pick<ProviderHolder, 'handle' | 'issuer' | 'current'>
  }
}

export const buildApp = ({ getDatabaseTime, oidc, admin }: AppDependencies) => {
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
    void app.register(oidcRoutes(oidc.provider))
    void app.register(interactionRoutes(oidc))
  }
  if (admin) {
    void app.register(adminRoutes(admin), { prefix: '/admin' })
  }

  return app
}
