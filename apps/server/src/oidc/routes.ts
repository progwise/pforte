import type { FastifyInstance } from 'fastify'
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
 *
 * The provider builds its absolute URLs (discovery, redirects, cookies' Secure flag) from the
 * request's host and protocol. Those would otherwise follow whatever Host header a client or
 * proxy sends, so they are overwritten with the configured issuer: every URL derives from ISSUER.
 */
export const oidcRoutes = (provider: Pick<ProviderHolder, 'handle' | 'issuer'>) => async (app: FastifyInstance) => {
  const issuer = new URL(provider.issuer)

  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', (_request, _payload, done) => done(null))

  for (const url of providerPaths) {
    app.route({
      method: ['GET', 'POST', 'OPTIONS'],
      url,
      handler: async (request, reply) => {
        const { headers } = request.raw
        headers.host = issuer.host
        headers['x-forwarded-proto'] = issuer.protocol.replace(':', '')
        delete headers['x-forwarded-host']

        reply.hijack()
        provider.handle(request.raw, reply.raw)
      },
    })
  }
}
