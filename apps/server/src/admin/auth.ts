import type { Database } from '@progwise/pforte-db'
import { findActiveUserById, findClientById } from '@progwise/pforte-db/oidc'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { RateLimiter } from '../auth/rate-limiter.js'
import { ADMIN_UI_CLIENT_ID } from '../manage/constants.js'
import type { ProviderHolder } from '../oidc/provider.js'
import { problem } from './problem.js'

export type AdminScope = 'admin' | 'directory'

/** The authenticated caller of the admin API: a machine (a client) or a person who signed in to the administration UI. */
export interface AdminCaller {
  kind: 'client' | 'user'
  /** The client the token was issued to: the machine itself, or the administration UI for a person. */
  clientId: string
  scopes: string[]
  /** The person, for `kind: 'user'`. */
  user?: { id: string; email: string; firstName: string; lastName: string; language: string }
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
 * Authenticates calls to the admin API. Two kinds of token are accepted, both looked up in pforte's own
 * store, so they must be ones this provider issued:
 *
 * - A **machine's** token from the client_credentials grant. The client's scopes in the database decide on
 *   every request, so removing a scope takes effect at once instead of when the token expires.
 *   `admin` allows everything; `directory` only what an import needs (users and claims).
 * - A **person's** token from the authorization code flow, but only one issued to the administration UI, and
 *   only while that person is active and an administrator. That is checked on every request too, so locking
 *   someone or taking the admin right away ends their access at once. Such a person has the `admin` scope, and
 *   what they change is recorded under their own name.
 *
 * A token of any other application, even for an administrator, is not accepted.
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

  const machineCaller = async (token: string): Promise<AdminCaller | undefined> => {
    const credentials = await provider.current().ClientCredentials.find(token)
    if (!credentials?.clientId) return undefined
    const client = await findClientById(db, credentials.clientId)
    if (!client) return undefined
    return {
      kind: 'client',
      clientId: client.clientId,
      scopes: (credentials.scope ?? '').split(' ').filter((scope) => client.scopes.includes(scope)),
    }
  }

  const personCaller = async (token: string): Promise<AdminCaller | undefined> => {
    const access = await provider.current().AccessToken.find(token)
    if (!access?.accountId || access.clientId !== ADMIN_UI_CLIENT_ID) return undefined
    const user = await findActiveUserById(db, access.accountId)
    if (!user?.isAdmin) return undefined
    return {
      kind: 'user',
      clientId: ADMIN_UI_CLIENT_ID,
      scopes: ['admin'],
      user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, language: user.language },
    }
  }

  /**
   * A route hook: only callers holding one of the given scopes may continue. The hook carries its scopes, so that the OpenAPI
   * document can say what each operation needs without a second list that could drift.
   */
  const require = (...allowed: AdminScope[]) =>
    Object.assign(
      async (request: FastifyRequest, reply: FastifyReply) => {
        const token = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? '')?.[1]
        if (!token) return unauthorized(request, reply)

        const caller = (await machineCaller(token)) ?? (await personCaller(token))
        if (!caller) return unauthorized(request, reply)

        if (!allowed.some((scope) => caller.scopes.includes(scope))) {
          return problem(reply, 403, 'Forbidden', `This call needs the ${allowed.join(' or ')} scope.`)
        }

        request.admin = caller
      },
      { scopes: allowed as readonly AdminScope[] },
    )

  return { require }
}

export type AdminAuth = ReturnType<typeof createAdminAuth>

export const hasScope = (request: FastifyRequest, scope: AdminScope) => request.admin?.scopes.includes(scope) ?? false
