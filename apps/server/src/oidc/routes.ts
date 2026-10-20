import type { FastifyInstance } from 'fastify'
import type { RateLimiter } from '../auth/rate-limiter.js'
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
export const oidcRoutes = (provider: Pick<ProviderHolder, 'handle' | 'issuer'>, limiter: RateLimiter) => async (app: FastifyInstance) => {
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', (_request, _payload, done) => done(null))

  for (const url of providerPaths) {
    app.route({
      method: ['GET', 'POST', 'OPTIONS'],
      url,
      handler: async (request, reply) => {
        // Applications authenticate here with their secret, so this is where a secret can be guessed. Failed
        // attempts are counted per IP, and an IP that failed too often waits before it may try again, so a guess
        // is not even looked at while it waits.
        if (request.method === 'POST' && request.url.split('?')[0] === '/token') {
          const wait = await limiter.clientAuthBlockedFor(request.ip)
          if (wait > 0) {
            return reply
              .code(429)
              .header('Retry-After', wait)
              .send({ error: 'temporarily_unavailable', error_description: `Too many failed attempts to authenticate. Try again in ${wait} seconds.` })
          }
          reply.raw.once('finish', () => {
            if (reply.raw.statusCode === 401) {
              limiter.clientAuthFailed(request.ip).catch((error) => request.log.error(error, 'counting a failed client authentication failed'))
            }
          })
        }
        applyIssuerHeaders(request.raw, provider.issuer)
        reply.hijack()
        provider.handle(request.raw, reply.raw)
      },
    })
  }
}
