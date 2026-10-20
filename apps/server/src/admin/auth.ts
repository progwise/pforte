import type { Database } from '@progwise/pforte-db'
import { findClientById } from '@progwise/pforte-db/oidc'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { RateLimiter } from '../auth/rate-limiter.js'
import type { ProviderHolder } from '../oidc/provider.js'
import { problem } from './problem.js'

export type AdminScope = 'admin' | 'directory'

/** The authenticated caller of the admin API. */
export interface AdminCaller {
  clientId: string
  scopes: string[]
}

declare module 'fastify' {
  interface FastifyRequest {
    admin?: AdminCaller
  }
}

export interface AdminAuthDependencies {
  provider: Pick<ProviderHolder, 'current'>
  db: Database
  /** Counts failed authentications, and says when there were too many. */
  limiter: RateLimiter
}

/**
 * Authenticates calls to the admin API with an access token from the client_credentials grant.
 *
 * The token is looked up in pforte's own store, so it must be one this provider issued, for this
 * grant type: a token from the authorization code flow is a different model and never matches. The
 * client's scopes in the database decide on every request, so removing a scope takes effect at
 * once instead of when the token expires.
 *
 * `admin` allows everything; `directory` only what an import needs (users and claims).
 */
export const createAdminAuth = ({ provider, db, limiter }: AdminAuthDependencies) => {
  /**
   * A failed authentication: counted per IP, and once an IP has failed too often it is told to wait.
   * Checking the token comes first, so an administrator whose token is valid is never held back, not
   * even from an IP that others have failed from. Tokens are long and random, so guessing one is hopeless
   * anyway; the limit is about noise and probing.
   */
  const unauthorized = async (request: FastifyRequest, reply: FastifyReply) => {
    const wait = await limiter.clientAuthBlockedFor(request.ip)
    if (wait > 0) {
      return problem(reply, 429, 'Too many requests', `Too many failed attempts to authenticate. Try again in ${wait} seconds.`, {
        'Retry-After': String(wait),
      })
    }
    await limiter.clientAuthFailed(request.ip)
    return problem(reply, 401, 'Unauthorized', 'A valid access token is required.', {
      'WWW-Authenticate': 'Bearer realm="pforte-admin"',
    })
  }

  /** A route hook: only callers holding one of the given scopes may continue. */
  const require =
    (...allowed: AdminScope[]) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? '')?.[1]
      if (!token) return unauthorized(request, reply)

      const credentials = await provider.current().ClientCredentials.find(token)
      if (!credentials?.clientId) return unauthorized(request, reply)

      const client = await findClientById(db, credentials.clientId)
      if (!client) return unauthorized(request, reply)

      const granted = (credentials.scope ?? '').split(' ').filter((scope) => client.scopes.includes(scope))
      if (!allowed.some((scope) => granted.includes(scope))) {
        return problem(reply, 403, 'Forbidden', `This call needs the ${allowed.join(' or ')} scope.`)
      }

      request.admin = { clientId: client.clientId, scopes: granted }
    }

  return { require }
}

export type AdminAuth = ReturnType<typeof createAdminAuth>

export const hasScope = (request: FastifyRequest, scope: AdminScope) => request.admin?.scopes.includes(scope) ?? false
