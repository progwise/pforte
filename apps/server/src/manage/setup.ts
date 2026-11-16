import type { Database } from '@progwise/pforte-db'
import { ensureSystemClient } from '@progwise/pforte-db/admin'
import { ADMIN_UI_CLIENT_ID, ADMIN_UI_NAME, MANAGE_PATH } from './constants.js'

/**
 * Registers the client the administration UI signs in with, for the public address of this pforte. Its start address
 * is the administration itself, so the page that ends an activation or a password reset can lead on to it.
 */
export const ensureAdminUiClient = (db: Database, issuer: string) =>
  ensureSystemClient(db, {
    clientId: ADMIN_UI_CLIENT_ID,
    name: ADMIN_UI_NAME,
    clientUri: `${issuer}${MANAGE_PATH}`,
    redirectUris: [`${issuer}${MANAGE_PATH}/callback`],
    postLogoutRedirectUris: [`${issuer}${MANAGE_PATH}/signed-out`],
    scopes: ['openid', 'profile'],
  })
