import type { Database } from '@progwise/pforte-db'
import { ensureSystemClient } from '@progwise/pforte-db/admin'
import { ADMIN_UI_CLIENT_ID, MANAGE_PATH } from './constants.js'

/** Registers the client the administration UI signs in with, for the public address of this pforte. */
export const ensureAdminUiClient = (db: Database, issuer: string) =>
  ensureSystemClient(db, {
    clientId: ADMIN_UI_CLIENT_ID,
    name: 'Administration',
    redirectUris: [`${issuer}${MANAGE_PATH}/callback`],
    postLogoutRedirectUris: [`${issuer}${MANAGE_PATH}/signed-out`],
    scopes: ['openid', 'profile'],
  })
