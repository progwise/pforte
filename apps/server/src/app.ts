import Fastify, { type FastifyServerOptions } from 'fastify'
import { accountRoutes, type AccountDependencies } from './account/routes.js'
import { type AdminDependencies, adminRoutes } from './admin/index.js'
import type { InteractionDependencies } from './interaction/routes.js'
import { interactionRoutes } from './interaction/routes.js'
import { brandRoutes } from './ui/brand-routes.js'
import type { Ui } from './ui/index.js'
import { oidcRoutes } from './oidc/routes.js'
import type { ProviderHolder } from './oidc/provider.js'

export interface AppDependencies {
  /** The admin API. Needs the provider (to verify tokens) and the database. */
  admin?: AdminDependencies
  /** Serves the logo and the fonts of the branding folder. */
  ui?: Pick<Ui, 'theme'>
  /** The pages for choosing the first password and for a forgotten one. */
  account?: AccountDependencies
  /** How many proxies stand in front of pforte; see `Config.trustProxy`. */
  trustProxy?: number
  /** Returns the current time as reported by the database. */
  getDatabaseTime: () => Promise<Date>
  /** The OpenID Connect provider and its login. Omitted in tests that do not need them. */
  oidc?: Omit<InteractionDependencies, 'provider'> & {
    provider: Pick<ProviderHolder, 'handle' | 'issuer' | 'current'>
  }
}

export const buildApp = ({ getDatabaseTime, oidc, admin, account, ui, trustProxy = 0 }: AppDependencies) => {
  // "The first N proxies are trusted": the client is what the Nth proxy from the end says it is.
  const options: FastifyServerOptions = {
    logger: process.env.NODE_ENV !== 'test',
    trustProxy: trustProxy > 0 ? (_address, hop) => hop < trustProxy : false,
  }
  const app = Fastify(options)

  // Rate limits count by client address. Behind a proxy without TRUST_PROXY that address is the proxy's,
  // and everybody would be counted together: worth saying once, loudly.
  if (trustProxy === 0) {
    let warned = false
    app.addHook('onRequest', async (request) => {
      if (!warned && request.headers['x-forwarded-for']) {
        warned = true
        request.log.warn('A request carried X-Forwarded-For, but TRUST_PROXY is not set: the rate limits see the proxy\'s address for everybody. Set TRUST_PROXY to the number of proxies in front of pforte.')
      }
    })
  }

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
    void app.register(oidcRoutes(oidc.provider, oidc.limiter))
    void app.register(interactionRoutes(oidc))
  }
  if (ui && ui.theme.assets.length > 0) {
    void app.register(brandRoutes(ui.theme.assets))
  }
  if (account) {
    void app.register(accountRoutes(account))
  }
  if (admin) {
    void app.register(adminRoutes(admin), { prefix: '/admin' })
  }

  return app
}
