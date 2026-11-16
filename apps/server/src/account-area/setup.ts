import type { Database } from '@progwise/pforte-db'
import { ensureSystemClient, SystemClientIdTakenError } from '@progwise/pforte-db/admin'
import { ACCOUNT_PATH, ACCOUNT_UI_CLIENT_ID } from './constants.js'

/** Whether the account pages can be served, and if not, what the operator has to do. */
export type AccountPagesAvailability = { available: true } | { available: false; reason: string }

/**
 * Registers the client the account pages sign in with, for the public address of this pforte. It asks for nothing
 * but `openid`: the pages read the person from the database, and the token they get is never used for anything.
 *
 * A pforte from before the account pages let an administrator register a client under this very ID. Such a client
 * is not touched. The pages then stay off until the operator has moved their application to another ID, and the
 * answer says how.
 */
export const ensureAccountUiClient = async (db: Database, issuer: string): Promise<AccountPagesAvailability> => {
  try {
    await ensureSystemClient(db, {
      clientId: ACCOUNT_UI_CLIENT_ID,
      name: 'Account',
      // Where the page that ends a password reset leads on to, when the reset began at the sign-in of these pages.
      clientUri: `${issuer}${ACCOUNT_PATH}`,
      redirectUris: [`${issuer}${ACCOUNT_PATH}/callback`],
      postLogoutRedirectUris: [`${issuer}${ACCOUNT_PATH}/signed-out`],
      scopes: ['openid'],
    })
    return { available: true }
  } catch (error) {
    if (!(error instanceof SystemClientIdTakenError)) throw error
    return {
      available: false,
      reason:
        `The account pages (${ACCOUNT_PATH}) are switched off: a client with the ID "${ACCOUNT_UI_CLIENT_ID}" was registered by an administrator, and pforte ` +
        `needs that ID for the pages. Your client was not changed. Register that application under another ID, delete this one (in the administration, or ` +
        `DELETE /admin/clients/${ACCOUNT_UI_CLIENT_ID}) and restart pforte.`,
    }
  }
}
