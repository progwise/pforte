import { generateKeyPairSync } from 'node:crypto'
import { getDatabaseTime } from '@progwise/pforte-db'
import { seed } from '@progwise/pforte-db/seed'
import { createTestDatabase } from '@progwise/pforte-db/testing'
import { expect } from 'vitest'
import { buildApp } from '../app.js'
import { createAuthenticate } from '../auth/authenticate.js'
import { createProviderHolder } from '../oidc/provider.js'
import { basicAuth } from './browser.js'

export const ISSUER = 'https://localhost:3300'

/** A seeded test database with the whole app (provider, login and admin API) on top of it. */
export const createAdminHarness = async () => {
  const database = await createTestDatabase()
  await seed(database.db)

  const jwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' })
  const provider = await createProviderHolder({
    config: {
      issuer: ISSUER,
      cookieKeys: ['k'.repeat(40)],
      jwks: { keys: [{ ...jwk, kty: 'RSA', kid: 'test-key', alg: 'RS256', use: 'sig' }] },
    },
    db: database.db,
  })
  const app = buildApp({
    getDatabaseTime: () => getDatabaseTime(database.db),
    oidc: { provider, authenticate: await createAuthenticate(database.db) },
    admin: { db: database.db, provider },
  })
  await app.ready()

  const tokenFor = async (clientId: string, scope: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { authorization: basicAuth(clientId, 'dev-secret'), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'client_credentials', scope }).toString(),
    })
    expect(response.statusCode, response.body).toBe(200)
    return response.json().access_token as string
  }

  const adminToken = await tokenFor('demo-admin', 'admin')
  const directoryToken = await tokenFor('demo-import', 'directory')

  const api = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    { token = adminToken, body }: { token?: string | null; body?: unknown } = {},
  ) =>
    app.inject({
      method,
      url: `/admin${url}`,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'user-agent': 'admin-test/1.0',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      payload: body === undefined ? undefined : JSON.stringify(body),
    })

  const count = async (table: string, where = 'true') =>
    Number((await database.pool.query(`select count(*) from ${table} where ${where}`)).rows[0].count)

  const audit = async (action: string, targetId: string) =>
    (await database.pool.query(`select * from audit_events where action = $1 and target_id = $2 order by created_at`, [action, targetId])).rows

  return {
    app,
    database,
    provider,
    api,
    tokenFor,
    adminToken,
    directoryToken,
    count,
    audit,
    close: async () => {
      await app.close()
      await database.drop()
    },
  }
}

export type AdminHarness = Awaited<ReturnType<typeof createAdminHarness>>
