import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { basicAuth, Browser, signIn, verifyJwt } from '../test/browser.js'

describe.skipIf(!hasDatabase)('admin API: clients', () => {
  let h: AdminHarness

  beforeAll(async () => {
    h = await createAdminHarness()
  })

  afterAll(async () => {
    await h?.close()
  })

  const shop = {
    clientId: 'shop-web',
    name: 'Shop',
    type: 'confidential',
    redirectUris: ['https://shop.example.com/callback'],
    postLogoutRedirectUris: ['https://shop.example.com/'],
  }

  const create = (body: Record<string, unknown>) => h.api('POST', '/clients', { body })

  /** Signs a seeded user in through the given client and returns the ID token claims. */
  const idTokenClaims = async (client: { clientId: string; redirectUri: string; secret?: string }, email = 'anna.schmidt@example.com') => {
    const browser = new Browser(h.app)
    const { code, verifier } = await signIn(browser, { clientId: client.clientId, redirectUri: client.redirectUri, email })
    expect(code, 'the sign-in should end with a code').toBeTruthy()
    const response = await browser.request('POST', '/token', {
      form: {
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: client.redirectUri,
        client_id: client.clientId,
        code_verifier: verifier,
      },
      headers: client.secret ? { authorization: basicAuth(client.clientId, client.secret) } : {},
    })
    return { status: response.statusCode, body: response.json(), claims: response.statusCode === 200 ? (await verifyJwt(h.app, response.json().id_token)).claims : undefined }
  }

  describe('reading', () => {
    it('lists the clients with their claim types, and never a secret', async () => {
      const response = await h.api('GET', '/clients')

      expect(response.statusCode).toBe(200)
      const demoWeb = response.json().items.find((client: { clientId: string }) => client.clientId === 'demo-web')
      expect(demoWeb).toMatchObject({ type: 'public', pkceRequired: true, claimTypes: ['partner_no'] })
      expect(response.body).not.toMatch(/secret/i)
      expect(response.body).not.toContain('argon2')
    })

    it('needs the admin scope', async () => {
      expect((await h.api('GET', '/clients', { token: h.directoryToken })).statusCode).toBe(403)
      expect((await h.api('GET', '/clients', { token: null })).statusCode).toBe(401)
    })

    it('answers 404 for an unknown client', async () => {
      expect((await h.api('GET', '/clients/nothing-here')).statusCode).toBe(404)
    })
  })

  describe('registering an application', () => {
    it('creates a confidential client, returns its secret once, and lets users sign in through it', async () => {
      const response = await create({ ...shop })

      expect(response.statusCode).toBe(201)
      expect(response.headers.location).toBe('/admin/clients/shop-web')
      const { client, clientSecret } = response.json()
      expect(clientSecret).toMatch(/^[\w-]{43}$/)
      expect(client).toMatchObject({ clientId: 'shop-web', type: 'confidential', pkceRequired: true, claimTypes: [] })
      expect(client.scopes).toEqual(['openid', 'offline_access', 'profile', 'email', 'phone'])

      // The secret is not shown again, and only its hash is stored.
      expect((await h.api('GET', '/clients/shop-web')).body).not.toContain(clientSecret)
      const row = (await h.database.pool.query(`select secret_hash from clients where client_id = 'shop-web'`)).rows[0]
      expect(row.secret_hash).toMatch(/^\$argon2id\$/)
      expect(row.secret_hash).not.toContain(clientSecret)

      // The new client works at once, with the claim types assigned to it and no others.
      await h.api('PUT', '/clients/shop-web/claim-types', { body: { claimTypes: ['partner_no'] } })
      const result = await idTokenClaims(
        { clientId: 'shop-web', redirectUri: 'https://shop.example.com/callback', secret: clientSecret },
      )
      expect(result.status).toBe(200)
      expect(result.claims).toMatchObject({ aud: 'shop-web', partner_no: ['00892'] })
      expect(result.claims).not.toHaveProperty('customer_no')
    })

    it('refuses a wrong secret for the new client', async () => {
      const result = await idTokenClaims({ clientId: 'shop-web', redirectUri: 'https://shop.example.com/callback', secret: 'not-the-secret' })

      expect(result.status).toBe(401)
    })

    it('creates a public client without a secret', async () => {
      const response = await create({ clientId: 'shop-spa', name: 'Shop SPA', type: 'public', redirectUris: ['https://spa.example.com/cb'] })

      expect(response.statusCode).toBe(201)
      expect(response.json().clientSecret).toBeNull()
      expect(response.json().client.pkceRequired).toBe(true)
      expect((await h.database.pool.query(`select secret_hash from clients where client_id = 'shop-spa'`)).rows[0].secret_hash).toBeNull()
    })

    it('lets a confidential client skip PKCE only when an administrator says so', async () => {
      const response = await create({ ...shop, clientId: 'legacy-erp', name: 'Legacy ERP', pkceRequired: false })

      expect(response.json().client.pkceRequired).toBe(false)
      const refused = await create({ clientId: 'bad-spa', name: 'Bad', type: 'public', redirectUris: ['https://x.example.com/cb'], pkceRequired: false })
      expect(refused.statusCode).toBe(400)
      expect(JSON.stringify(refused.json().errors)).toContain('/pkceRequired')
    })

    it('records who registered it, without the secret', async () => {
      const response = await create({ ...shop, clientId: 'audited-app', name: 'Audited' })

      const [event] = await h.audit('client.create', 'audited-app')
      expect(event).toMatchObject({ actor_id: 'demo-admin', user_agent: 'admin-test/1.0' })
      expect(JSON.stringify(event)).not.toContain(response.json().clientSecret)
    })

    it('keeps a start address, which can be changed and removed', async () => {
      const created = await create({ ...shop, clientId: 'with-start', clientUri: 'https://shop.example.com/start' })
      expect(created.statusCode).toBe(201)
      expect(created.json().client.clientUri).toBe('https://shop.example.com/start')

      const moved = await h.api('PATCH', '/clients/with-start', { body: { clientUri: 'http://localhost:5173/' } })
      expect(moved.json().clientUri).toBe('http://localhost:5173/')
      const refused = await h.api('PATCH', '/clients/with-start', { body: { clientUri: 'http://shop.example.com/' } })
      expect(refused.statusCode).toBe(400)
      const removed = await h.api('PATCH', '/clients/with-start', { body: { clientUri: null } })
      expect(removed.json().clientUri).toBeNull()
      expect((await create({ ...shop, clientId: 'no-start' })).json().client.clientUri).toBeNull()
    })

    it('refuses a client id that exists', async () => {
      expect((await create({ ...shop })).statusCode).toBe(409)
    })

    it.each([
      ['an http redirect URI', { redirectUris: ['http://shop.example.com/cb'] }, '/redirectUris/0'],
      ['a wildcard redirect URI', { redirectUris: ['https://*.example.com/cb'] }, '/redirectUris/0'],
      ['an admin scope on an application', { scopes: ['openid', 'admin'] }, '/scopes'],
      ['no redirect URI', { redirectUris: [] }, '/redirectUris'],
      ['an invalid client id', { clientId: 'Not Valid' }, 'clientId'],
      ['an http start address', { clientUri: 'http://shop.example.com/' }, '/clientUri'],
      ['a start address with a fragment', { clientUri: 'https://shop.example.com/#top' }, '/clientUri'],
      ['a start address that is no address', { clientUri: 'shop' }, '/clientUri'],
    ])('refuses %s', async (_name, change, path) => {
      const response = await create({ ...shop, clientId: 'invalid-one', ...change })

      expect(response.statusCode).toBe(400)
      expect(JSON.stringify(response.json().errors)).toContain(path)
      expect((await h.api('GET', '/clients/invalid-one')).statusCode).toBe(404)
    })
  })

  describe('registering a machine', () => {
    it('creates an import client that gets an admin API token but can do no more than its scope allows', async () => {
      const response = await create({ clientId: 'hourly-import', name: 'Hourly import', type: 'confidential', allowedGrants: ['client_credentials'], scopes: ['directory'] })

      expect(response.statusCode).toBe(201)
      const { clientSecret } = response.json()
      const token = (
        await h.app.inject({
          method: 'POST',
          url: '/token',
          headers: { authorization: basicAuth('hourly-import', clientSecret), 'content-type': 'application/x-www-form-urlencoded' },
          payload: 'grant_type=client_credentials&scope=directory',
        })
      ).json().access_token

      expect((await h.api('GET', '/users?limit=1', { token })).statusCode).toBe(200)
      expect((await h.api('GET', '/clients', { token })).statusCode).toBe(403)
    })

    it.each([
      ['an OpenID scope', { scopes: ['openid'] }, '/scopes'],
      ['no scope', {}, '/scopes'],
      ['a redirect URI', { scopes: ['directory'], redirectUris: ['https://x.example.com/cb'] }, '/redirectUris'],
      ['a public machine', { scopes: ['directory'], type: 'public' }, '/type'],
    ])('refuses a machine with %s', async (_name, change, path) => {
      const response = await create({ clientId: 'bad-machine', name: 'Bad', type: 'confidential', allowedGrants: ['client_credentials'], ...change })

      expect(response.statusCode).toBe(400)
      expect(JSON.stringify(response.json().errors)).toContain(path)
    })
  })

  describe('changing', () => {
    it('takes a new redirect URI into effect at once and refuses the one that was removed', async () => {
      await create({ ...shop, clientId: 'moving-app', name: 'Moving', redirectUris: ['https://old.example.com/cb'] })
      const authorize = (redirectUri: string) => {
        const query = new URLSearchParams({
          client_id: 'moving-app',
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: 'openid',
          state: 's',
          code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          code_challenge_method: 'S256',
        })
        return new Browser(h.app).request('GET', `/auth?${query}`)
      }
      expect((await authorize('https://old.example.com/cb')).headers.location).toMatch(/^\/interaction\//)
      expect((await authorize('https://new.example.com/cb')).statusCode).toBeGreaterThanOrEqual(400)

      const response = await h.api('PATCH', '/clients/moving-app', { body: { redirectUris: ['https://new.example.com/cb'] } })

      expect(response.statusCode).toBe(200)
      expect((await authorize('https://new.example.com/cb')).headers.location).toMatch(/^\/interaction\//)
      expect((await authorize('https://old.example.com/cb')).statusCode).toBeGreaterThanOrEqual(400)
    })

    it('records the difference, and nothing when nothing differs', async () => {
      await create({ ...shop, clientId: 'quiet-app', name: 'Quiet' })

      await h.api('PATCH', '/clients/quiet-app', { body: { name: 'Louder' } })
      await h.api('PATCH', '/clients/quiet-app', { body: { name: 'Louder' } })

      const events = await h.audit('client.update', 'quiet-app')
      expect(events).toHaveLength(1)
      expect(events[0].details.changes.name).toEqual({ from: 'Quiet', to: 'Louder' })
    })

    it('requires the result to stay a valid client', async () => {
      const response = await h.api('PATCH', '/clients/shop-web', { body: { redirectUris: [] } })

      expect(response.statusCode).toBe(400)
      expect((await h.api('GET', '/clients/shop-web')).json().redirectUris).toHaveLength(1)
    })

    it('answers 404 for an unknown client and 400 for an empty change', async () => {
      expect((await h.api('PATCH', '/clients/ghost', { body: { name: 'x' } })).statusCode).toBe(404)
      expect((await h.api('PATCH', '/clients/shop-web', { body: {} })).statusCode).toBe(400)
    })

    it('does not let the last admin client lose its scope', async () => {
      const response = await h.api('PATCH', '/clients/demo-admin', { body: { scopes: ['directory'] } })

      expect(response.statusCode).toBe(409)
      expect(response.json().detail).toContain('last client with the admin scope')
    })
  })

  describe('rotating the secret', () => {
    it('stops the old secret at once and accepts the new one', async () => {
      const created = (await create({ ...shop, clientId: 'rotating-app', name: 'Rotating' })).json()
      const client = { clientId: 'rotating-app', redirectUri: 'https://shop.example.com/callback' }

      const rotated = await h.api('POST', '/clients/rotating-app/rotate-secret')

      expect(rotated.statusCode).toBe(200)
      expect(rotated.json().clientSecret).toMatch(/^[\w-]{43}$/)
      expect(rotated.json().clientSecret).not.toBe(created.clientSecret)
      expect((await idTokenClaims({ ...client, secret: created.clientSecret })).status).toBe(401)
      expect((await idTokenClaims({ ...client, secret: rotated.json().clientSecret })).status).toBe(200)
      expect(JSON.stringify(await h.audit('client.rotate_secret', 'rotating-app'))).not.toContain(rotated.json().clientSecret)
    })

    it('refuses a public client and an unknown client', async () => {
      expect((await h.api('POST', '/clients/shop-spa/rotate-secret')).statusCode).toBe(409)
      expect((await h.api('POST', '/clients/ghost/rotate-secret')).statusCode).toBe(404)
    })
  })

  describe('deleting', () => {
    it('revokes the grants and tokens of the client and removes it', async () => {
      const created = (await create({ ...shop, clientId: 'doomed-app', name: 'Doomed' })).json()
      const client = { clientId: 'doomed-app', redirectUri: 'https://shop.example.com/callback', secret: created.clientSecret }
      expect((await idTokenClaims(client)).status).toBe(200)
      expect(Number((await h.database.pool.query(`select count(*) from oidc_payloads where payload->>'clientId' = 'doomed-app'`)).rows[0].count)).toBeGreaterThan(0)

      const response = await h.api('DELETE', '/clients/doomed-app')

      expect(response.statusCode).toBe(204)
      expect(Number((await h.database.pool.query(`select count(*) from oidc_payloads where payload->>'clientId' = 'doomed-app'`)).rows[0].count)).toBe(0)
      expect((await h.api('GET', '/clients/doomed-app')).statusCode).toBe(404)
      const [event] = await h.audit('client.delete', 'doomed-app')
      expect(event.details.tokensAndGrantsRevoked).toBeGreaterThan(0)
    })

    it('refuses a client deleting itself, and answers 404 for an unknown client', async () => {
      const self = await h.api('DELETE', '/clients/demo-admin')

      expect(self.statusCode).toBe(409)
      expect(self.json().detail).toContain('cannot delete itself')
      expect((await h.api('DELETE', '/clients/ghost')).statusCode).toBe(404)
    })
  })
})

describe.skipIf(!hasDatabase)('admin API: back-channel logout addresses on a private network', () => {
  const app = (extra: Record<string, unknown>) => ({
    clientId: 'bc-app',
    name: 'Back-channel app',
    type: 'public',
    redirectUris: ['https://bc.example.com/cb'],
    ...extra,
  })

  const accepted = [
    'http://host.docker.internal:3000/auth/backchannel-logout',
    'http://api:3000/auth/backchannel-logout',
    'http://127.0.0.1:3000/logout',
    'http://10.1.2.3/logout',
    'http://172.16.0.5/logout',
    'http://192.168.1.20:8080/logout',
    'http://169.254.10.10/logout',
    'http://[::1]:3000/logout',
    'http://[fd12:3456::1]/logout',
    'http://localhost:3000/logout',
    'https://bc.example.com/logout',
  ]
  const refused = ['http://example.com/logout', 'http://8.8.8.8/logout', 'http://172.32.0.1/logout', 'http://203.0.113.9/logout', 'http://app.example.internal/logout', 'ftp://api/logout', 'http://api/logout#x']

  it('is refused when the operator has not allowed private addresses, except for localhost', async () => {
    const h = await createAdminHarness()
    try {
      for (const uri of accepted.filter((uri) => !/localhost|127\.0\.0\.1|\[::1\]|^https/.test(uri))) {
        const response = await h.api('POST', '/clients', { body: app({ clientId: 'bc-refused', backchannelLogoutUri: uri }) })
        expect(response.statusCode, uri).toBe(400)
        expect(JSON.stringify(response.json().errors)).toContain('OUTBOUND_ALLOW_PRIVATE_ADDRESSES')
      }
      for (const uri of ['http://localhost:3000/logout', 'https://bc.example.com/logout']) {
        const response = await h.api('POST', '/clients', { body: app({ clientId: `bc-${uri.length}`, backchannelLogoutUri: uri }) })
        expect(response.statusCode, uri).toBe(201)
      }
    } finally {
      await h.close()
    }
  })

  it('is accepted for private addresses when the operator allows them, and nothing else changes', async () => {
    const h = await createAdminHarness({ allowPrivateAddresses: true })
    try {
      let n = 0
      for (const uri of accepted) {
        const response = await h.api('POST', '/clients', { body: app({ clientId: `bc-ok-${++n}`, backchannelLogoutUri: uri }) })
        expect(response.statusCode, uri).toBe(201)
      }
      for (const uri of refused) {
        const response = await h.api('POST', '/clients', { body: app({ clientId: `bc-no-${++n}`, backchannelLogoutUri: uri }) })
        expect(response.statusCode, uri).toBe(400)
      }
      // The same rule when changing a client, and redirect URIs keep theirs.
      const changed = await h.api('PATCH', '/clients/bc-ok-1', { body: { backchannelLogoutUri: 'http://api:3000/logout' } })
      expect(changed.statusCode).toBe(200)
      const redirect = await h.api('PATCH', '/clients/bc-ok-1', { body: { redirectUris: ['http://api:3000/cb'] } })
      expect(redirect.statusCode).toBe(400)
    } finally {
      await h.close()
    }
  })
})
