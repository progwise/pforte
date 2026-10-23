import { listRedirectUris } from '@progwise/pforte-db/oidc'
import type { Database } from '@progwise/pforte-db'
import type { Configuration } from 'oidc-provider'

/** Public documents: anybody may read them from any page. No credentials are ever involved. */
const publicPaths = new Set(['/.well-known/openid-configuration', '/jwks'])
/** Answered only to the origin of an application that is registered for the client concerned. */
const clientPaths = new Set(['/token', '/me'])

/** The origin of a redirect URI, or undefined for addresses without one (custom schemes). */
const originOf = (uri: string) => {
  const origin = URL.canParse(uri) ? new URL(uri).origin : undefined
  return origin === 'null' ? undefined : origin
}

/**
 * Which pages may read pforte's answers from a browser. The library reflects any `Origin`; this narrows it:
 *
 * - discovery and keys answer `*`,
 * - the token and userinfo endpoints answer only the origin of a redirect URI of the client in question,
 *   and a preflight request (which does not name its client) only an origin of any registered client,
 * - everything else sends no CORS headers,
 * - `Access-Control-Allow-Credentials` is never sent.
 */
export const createCors = (db: Database) => {
  type Middleware = Parameters<import('oidc-provider').default['use']>[0]

  const registeredOrigin = async (origin: string) => (await listRedirectUris(db)).some((uri) => originOf(uri) === origin)

  const middleware: Middleware = async (ctx, next) => {
    const origin = ctx.get('Origin')

    // The library skips its own CORS handling when a header is already set.
    if (publicPaths.has(ctx.path)) {
      ctx.vary('Origin')
      ctx.set('Access-Control-Allow-Origin', '*')
      if (ctx.method === 'OPTIONS' && ctx.get('Access-Control-Request-Method')) {
        ctx.set('Access-Control-Allow-Methods', 'GET')
        ctx.set('Access-Control-Max-Age', '3600')
        ctx.status = 204
        return undefined
      }
      return next()
    }
    if (!clientPaths.has(ctx.path)) {
      return next()
    }

    ctx.vary('Origin')
    if (ctx.method === 'OPTIONS' && ctx.get('Access-Control-Request-Method')) {
      if (origin && (await registeredOrigin(origin))) {
        ctx.set('Access-Control-Allow-Origin', origin)
        ctx.set('Access-Control-Allow-Methods', ctx.path === '/token' ? 'POST' : 'GET,POST')
        ctx.set('Access-Control-Allow-Headers', ctx.get('Access-Control-Request-Headers'))
        ctx.set('Access-Control-Max-Age', '3600')
      }
      ctx.status = 204
      return undefined
    }

    await next()
    // The library checks the origin against the client once it knows it. Without a client (a missing
    // or wrong token, a malformed request) or without an Origin, nothing was checked: send nothing.
    if (!origin || !(ctx as unknown as { oidc?: { client?: unknown } }).oidc?.client) {
      ctx.remove('Access-Control-Allow-Origin')
    }
    if (!ctx.response.get('Access-Control-Allow-Origin')) {
      ctx.remove('Access-Control-Expose-Headers')
    }
    return undefined
  }

  const clientBasedCORS: NonNullable<Configuration['clientBasedCORS']> = (ctx, origin, client) =>
    origin !== 'null' && (client.redirectUris ?? []).some((uri) => originOf(uri) === origin)

  return { middleware, clientBasedCORS }
}
