import type { FastifyInstance } from 'fastify'
import { applyIssuerHeaders } from './issuer-headers.js'
import type { ProviderHolder } from './provider.js'

/** The provider's endpoints at the root of the issuer. Everything below these paths is the provider's. */
const providerPaths = [
  '/.well-known/openid-configuration',
  '/jwks',
  '/auth',
  '/auth/*',
  '/token',
  '/token/*',
  '/me',
  '/session/end',
  '/session/end/*',
]

/**
 * Hands requests to node-oidc-provider. It reads the request body itself, so Fastify must not
 * consume it: this plugin installs parsers that leave the stream untouched.
 */
export const oidcRoutes = (provider: Pick<ProviderHolder, 'handle' | 'issuer'>) => async (app: FastifyInstance) => {
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', (_request, _payload, done) => done(null))

  for (const url of providerPaths) {
    app.route({
      method: ['GET', 'POST', 'OPTIONS'],
      url,
      handler: async (request, reply) => {
        applyIssuerHeaders(request.raw, provider.issuer)
        reply.hijack()
        provider.handle(request.raw, reply.raw)
      },
    })
  }
}
