import type { Database } from '@progwise/pforte-db'
import { ensureSystemClient } from '@progwise/pforte-db/admin'
import { ACCOUNT_PATH, ACCOUNT_UI_CLIENT_ID } from './constants.js'

/**
 * Registers the client the account pages sign in with, for the public address of this pforte. It asks for nothing
 * but `openid`: the pages read the person from the database, and the token they get is never used for anything.
 */
export const ensureAccountUiClient = (db: Database, issuer: string) =>
  ensureSystemClient(db, {
    clientId: ACCOUNT_UI_CLIENT_ID,
    name: 'Account',
    redirectUris: [`${issuer}${ACCOUNT_PATH}/callback`],
    postLogoutRedirectUris: [`${issuer}${ACCOUNT_PATH}/signed-out`],
    scopes: ['openid'],
  })
