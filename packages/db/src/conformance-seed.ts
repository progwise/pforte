import { randomBytes } from 'node:crypto'
import { hash } from '@node-rs/argon2'
import type { Database } from './index.js'
import { clients, users } from './schema/index.js'

export const CONFORMANCE_USER_EMAIL = 'conformance@example.com'

export interface ConformanceCredentials {
  alias: string
  redirectUris: string[]
  clients: { clientId: string; secret: string }[]
  user: { email: string; password: string }
}

const ALIAS = /^[a-z0-9][a-z0-9-]{2,40}$/

const randomSecret = () => randomBytes(24).toString('base64url')

/**
 * Registers what the OpenID conformance suite needs: two confidential clients that redirect to
 * the suite's callback for the given test-plan alias, and one test user. Secrets and the
 * password are generated fresh on every run and returned once; only hashes are stored.
 *
 * Meant for a separate, throwaway database that is reachable from the internet while tests run.
 * Never run it against production data.
 */
export const seedConformance = async (db: Database, { alias }: { alias: string }): Promise<ConformanceCredentials> => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed conformance data: NODE_ENV is production.')
  }
  if (!ALIAS.test(alias)) {
    throw new Error(`Invalid alias "${alias}": use 3-41 lowercase letters, digits and dashes`)
  }

  const callback = `https://www.certification.openid.net/test/a/${alias}/callback`
  // One suite test registers the callback with a query string and expects it to match exactly.
  const redirectUris = [callback, `${callback}?dummy1=lorem&dummy2=ipsum`]
  const postLogoutRedirectUris = [`https://www.certification.openid.net/test/a/${alias}/post_logout_redirect`]

  const credentials: ConformanceCredentials = {
    alias,
    redirectUris,
    clients: [
      { clientId: 'conformance-1', secret: randomSecret() },
      { clientId: 'conformance-2', secret: randomSecret() },
    ],
    user: { email: CONFORMANCE_USER_EMAIL, password: randomSecret() },
  }

  for (const { clientId, secret } of credentials.clients) {
    const values = {
      name: `OpenID conformance suite (${clientId})`,
      type: 'confidential' as const,
      secretHash: await hash(secret),
      // The suite's Basic profile does not use PKCE, which OpenID Connect Core makes optional
      // for confidential clients.
      pkceRequired: false,
      redirectUris,
      postLogoutRedirectUris,
    }
    await db
      .insert(clients)
      .values({ clientId, ...values })
      .onConflictDoUpdate({ target: clients.clientId, set: values })
  }

  const userValues = {
    passwordHash: await hash(credentials.user.password),
    phone: '+4915100099001',
    phoneVerifiedAt: new Date(),
    firstName: 'Conformance',
    lastName: 'Tester',
    status: 'active' as const,
  }
  await db
    .insert(users)
    .values({ email: CONFORMANCE_USER_EMAIL, ...userValues })
    .onConflictDoUpdate({ target: users.email, set: userValues })

  return credentials
}
