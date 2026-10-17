import { generateKeyPairSync } from 'node:crypto'
import { getDatabaseTime } from '@progwise/pforte-db'
import { seed } from '@progwise/pforte-db/seed'
import { createTestDatabase, hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { createAuthenticate } from '../auth/authenticate.js'
import { createUi } from '../ui/index.js'
import { registerCodeSource } from '../test/browser.js'
import { createRecordingNotifier } from '../test/recording-notifier.js'
import { createProviderHolder, type ProviderHolder } from './provider.js'

const testJwks = () => {
  const jwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' })
  return { keys: [{ ...jwk, kty: 'RSA', kid: 'test-key', alg: 'RS256', use: 'sig' }] }
}

describe.skipIf(!hasDatabase)('OpenID Connect provider', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>
  let oidc: ProviderHolder
  let app: ReturnType<typeof buildApp>

  const recording = createRecordingNotifier()

  beforeAll(async () => {
    database = await createTestDatabase()
    await seed(database.db)
    oidc = await createProviderHolder({
      config: { issuer: 'http://localhost:3300', cookieKeys: ['k'.repeat(40)], jwks: testJwks() },
      db: database.db,
    })
    app = buildApp({
      getDatabaseTime: () => getDatabaseTime(database.db),
      oidc: { provider: oidc, authenticate: await createAuthenticate(database.db), db: database.db, notifier: recording.notifier, cookieKeys: ['k'.repeat(40)], ui: createUi() },
    })
    await app.ready()
    registerCodeSource(app, recording.lastCode)
  })

  afterAll(async () => {
    await app?.close()
    await database?.drop()
  })

  const discovery = async () => {
    const response = await app.inject({ method: 'GET', url: '/.well-known/openid-configuration' })
    expect(response.statusCode).toBe(200)
    return response.json()
  }

  it('serves a discovery document for the configured issuer', async () => {
    const document = await discovery()

    expect(document.issuer).toBe('http://localhost:3300')
    expect(document.authorization_endpoint).toBe('http://localhost:3300/auth')
    expect(document.token_endpoint).toBe('http://localhost:3300/token')
    expect(document.userinfo_endpoint).toBe('http://localhost:3300/me')
    expect(document.jwks_uri).toBe('http://localhost:3300/jwks')
    expect(document.end_session_endpoint).toBe('http://localhost:3300/session/end')
  })

  it('supports the standard scopes', async () => {
    const document = await discovery()

    expect(document.scopes_supported).toEqual(
      expect.arrayContaining(['openid', 'offline_access', 'profile', 'email', 'phone']),
    )
  })

  it('offers only the authorization code flow with S256 PKCE', async () => {
    const document = await discovery()

    expect(document.response_types_supported).toEqual(['code'])
    expect(document.code_challenge_methods_supported).toEqual(['S256'])
    expect(document.grant_types_supported).toContain('refresh_token')
    expect(document.grant_types_supported).not.toContain('implicit')
  })

  it('announces back-channel logout and the claims of the database claim types', async () => {
    const document = await discovery()

    expect(document.backchannel_logout_supported).toBe(true)
    expect(document.claims_supported).toEqual(expect.arrayContaining(['sub', 'email', 'partner_no', 'customer_no']))
  })

  it('publishes the public signing keys and never the private parts', async () => {
    const response = await app.inject({ method: 'GET', url: '/jwks' })
    const { keys } = response.json()

    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatchObject({ kid: 'test-key', kty: 'RSA', use: 'sig' })
    for (const privatePart of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
      expect(keys[0]).not.toHaveProperty(privatePart)
    }
  })

  it('loads clients from the clients table', async () => {
    const { Client } = oidc.current()
    const web = await Client.find('demo-web')
    const backend = await Client.find('demo-backend')

    expect(web?.clientAuthMethod).toBe('none')
    expect(web?.redirectUris).toEqual(['http://localhost:3400/callback'])
    expect(backend?.clientAuthMethod).toBe('client_secret_basic')
    expect(await Client.find('does-not-exist')).toBeUndefined()
  })

  it('verifies client secrets against the stored argon2 hash', async () => {
    const backend = await oidc.current().Client.find('demo-backend')

    expect(await backend?.compareClientSecret('dev-secret')).toBe(true)
    expect(await backend?.compareClientSecret('wrong-secret')).toBe(false)
    expect(await backend?.compareClientSecret('')).toBe(false)
  })

  it('refuses an authorization request without PKCE', async () => {
    const query = new URLSearchParams({
      client_id: 'demo-web',
      redirect_uri: 'http://localhost:3400/callback',
      response_type: 'code',
      scope: 'openid',
      state: 'abc',
    })

    const response = await app.inject({ method: 'GET', url: `/auth?${query}` })

    expect(response.statusCode).toBe(303)
    const location = new URL(response.headers.location as string)
    expect(location.origin + location.pathname).toBe('http://localhost:3400/callback')
    expect(location.searchParams.get('error')).toBe('invalid_request')
    expect(location.searchParams.get('error_description')).toMatch(/PKCE/)
  })

  it('derives every URL from the issuer, whatever Host header the request carries', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/openid-configuration',
      headers: { host: 'evil.example.com', 'x-forwarded-host': 'evil.example.com', 'x-forwarded-proto': 'https' },
    })

    const document = response.json()
    expect(document.issuer).toBe('http://localhost:3300')
    expect(JSON.stringify(document)).not.toContain('evil.example.com')
  })

  it('redirects a valid authorization request to the login interaction', async () => {
    const query = new URLSearchParams({
      client_id: 'demo-web',
      redirect_uri: 'http://localhost:3400/callback',
      response_type: 'code',
      scope: 'openid offline_access',
      state: 'abc',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
    })

    const response = await app.inject({ method: 'GET', url: `/auth?${query}` })

    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toMatch(/^\/interaction\/[\w-]+$/)
  })

  it('picks up new claim types after a reload', async () => {
    await database.pool.query(`insert into claim_types (key) values ('cost_center')`)
    expect((await discovery()).claims_supported).not.toContain('cost_center')

    await oidc.reload()

    expect((await discovery()).claims_supported).toContain('cost_center')
  })
})
