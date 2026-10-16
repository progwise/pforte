import { findActiveUserById, getClaimsForClient } from '@progwise/pforte-db/oidc'
import type { Database } from '@progwise/pforte-db'
import type { FindAccount } from 'oidc-provider'

/** Standard OpenID claims kept per scope. Claim types from the database are added to `openid`. */
export const standardClaims = {
  openid: ['sub', 'email'],
  profile: ['name', 'given_name', 'family_name', 'locale'],
  phone: ['phone_number', 'phone_number_verified'],
} as const

/**
 * Resolves a token's subject to an account. Only active users resolve; a locked or deactivated
 * user therefore loses access as soon as their existing tokens are used or refreshed.
 */
export const createFindAccount =
  (db: Database): FindAccount =>
  async (ctx, sub) => {
    const user = await findActiveUserById(db, sub)
    if (!user) return undefined

    return {
      accountId: user.id,
      async claims() {
        const clientId = ctx?.oidc?.client?.clientId
        // The provider only releases the claim names it knows; which of them a client may
        // receive is decided here, by the claim types allowed for the client.
        const clientClaims = clientId ? await getClaimsForClient(db, user.id, clientId) : {}
        return {
          sub: user.id,
          email: user.email,
          name: `${user.firstName} ${user.lastName}`,
          given_name: user.firstName,
          family_name: user.lastName,
          locale: user.language,
          ...(user.phone
            ? { phone_number: user.phone, phone_number_verified: user.phoneVerifiedAt !== null }
            : {}),
          ...clientClaims,
        }
      },
    }
  }
