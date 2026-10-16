import { generateKeyPairSync } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { getDatabaseTime } from '@progwise/pforte-db'
import { seed } from '@progwise/pforte-db/seed'
import { createTestDatabase, hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { createAuthenticate } from '../auth/authenticate.js'
import { basicAuth, Browser, pkcePair, signIn, verifyJwt } from '../test/browser.js'
import { createProviderHolder, type ProviderHolder } from './provider.js'

// https, like every real deployment: the session cookie is then SameSite=None; Secure, which
// the POST binding of the authorization endpoint needs.
const ISSUER = 'https://localhost:3300'
const WEB = { clientId: 'demo-web', redirectUri: 'http://localhost:3400/callback' }
const BACKEND = { clientId: 'demo-backend', redirectUri: 'http://localhost:3500/callback' }

const testJwks = () => {
  const jwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' })
  return { keys: [{ ...jwk, kty: 'RSA', kid: 'test-key', alg: 'RS256', use: 'sig' }] }
}

describe.skipIf(!hasDatabase)('authorization code flow', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>
  let provider: ProviderHolder
  let app: ReturnType<typeof buildApp>

  beforeAll(async () => {
    database = await createTestDatabase()
    await seed(database.db)
    // Extra claims for anna: demo-web may only receive partner_no, demo-backend all three.
    await database.pool.query(`
      insert into user_claims (user_id, claim_type_key, value)
      select id, 'customer_no', '10001' from users where email = 'anna.schmidt@example.com'
      union all
      select id, 'branch_code', 'MUC' from users where email = 'anna.schmidt@example.com'`)
    provider = await createProviderHolder({
      config: {
        issuer: ISSUER,
        cookieKeys: ['k'.repeat(40)],
        jwks: testJwks(),
        // The test receiver for back-channel logout runs on loopback.
        allowPrivateAddresses: true,
      },
      db: database.db,
    })
    app = buildApp({
      getDatabaseTime: () => getDatabaseTime(database.db),
      oidc: { provider, authenticate: await createAuthenticate(database.db) },
    })
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
    await database?.drop()
  })

  const exchangeCode = (browser: Browser, client: typeof WEB, code: string, verifier: string, headers = {}) =>
    browser.request('POST', '/token', {
      form: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: client.redirectUri,
        client_id: client.clientId,
        code_verifier: verifier,
      },
      headers,
    })

  const loginAs = async (client: typeof WEB, scope = 'openid') => {
    const browser = new Browser(app)
    const result = await signIn(browser, { ...client, scope })
    expect(result.code, 'the sign-in should end with an authorization code').toBeTruthy()
    return { browser, ...result, code: result.code!, callback: result.callback! }
  }

  describe('login page', () => {
    it('shows a form for the application that asked', async () => {
      const browser = new Browser(app)
      const { loginPage } = await signIn(browser, { ...WEB, password: 'wrong' })

      expect(loginPage.statusCode).toBe(200)
      expect(loginPage.headers['content-type']).toMatch(/text\/html/)
      expect(loginPage.body).toContain('Sign in to Demo web app')
      expect(loginPage.body).toContain('type="password"')
      expect(loginPage.headers['content-security-policy']).toMatch(/default-src 'none'/)
      expect(loginPage.headers['cache-control']).toBe('no-store')
    })

    it.each([
      ['a wrong password', 'anna.schmidt@example.com', 'wrong-password'],
      ['an unknown e-mail', 'nobody@example.com', 'dev-password'],
    ])('answers %s with the same generic error', async (_name, email, password) => {
      const browser = new Browser(app)
      const { login } = await signIn(browser, { ...WEB, email, password })

      expect(login.statusCode).toBe(401)
      expect(login.body).toContain('The e-mail or password is not correct.')
      expect(login.body).not.toMatch(/unknown|locked|no such/i)
    })

    it.each(['locked', 'deactivated', 'created'])('refuses a user with status %s with the same error', async (status) => {
      await database.pool.query(`update users set status = $1 where email = 'felix.brandt@example.com'`, [status])
      const browser = new Browser(app)
      const { login } = await signIn(browser, { ...WEB, email: 'felix.brandt@example.com' })

      expect(login.statusCode).toBe(401)
      expect(login.body).toContain('The e-mail or password is not correct.')
      await database.pool.query(`update users set status = 'active' where email = 'felix.brandt@example.com'`)
    })

    it('does not reflect markup from the e-mail field', async () => {
      const browser = new Browser(app)
      const { login } = await signIn(browser, { ...WEB, email: '"><script>alert(1)</script>' })

      expect(login.body).not.toContain('<script>')
      expect(login.body).toContain('&lt;script&gt;')
    })

    it('redirects with access_denied when the user cancels', async () => {
      const browser = new Browser(app)
      const authorize = await signIn(browser, { ...WEB, password: 'wrong' })
      const interactionUrl = new URL(authorize.loginPage.raw.req.url as string, ISSUER).pathname
      const cancelled = await browser.request('POST', `${interactionUrl}/abort`)
      const resumed = await browser.request('GET', cancelled.headers.location as string)

      const callback = new URL(resumed.headers.location as string)
      expect(callback.origin + callback.pathname).toBe(WEB.redirectUri)
      expect(callback.searchParams.get('error')).toBe('access_denied')
    })

    it('rejects a login for an interaction the browser does not own', async () => {
      const response = await new Browser(app).request('POST', '/interaction/not-mine/login', {
        form: { email: 'anna.schmidt@example.com', password: 'dev-password' },
      })
      expect(response.statusCode).toBe(400)
    })

    it('updates last_login_at on success only', async () => {
      await database.pool.query(`update users set last_login_at = null where email = 'greta.lang@example.com'`)
      await signIn(new Browser(app), { ...WEB, email: 'greta.lang@example.com', password: 'wrong' })
      const failed = await database.pool.query(`select last_login_at from users where email = 'greta.lang@example.com'`)
      expect(failed.rows[0].last_login_at).toBeNull()

      await signIn(new Browser(app), { ...WEB, email: 'greta.lang@example.com' })
      const ok = await database.pool.query(`select last_login_at from users where email = 'greta.lang@example.com'`)
      expect(ok.rows[0].last_login_at).not.toBeNull()
    })
  })

  describe('public client with PKCE', () => {
    it('sets the session cookie SameSite=None and Secure, which the POST binding needs', async () => {
      const result = await signIn(new Browser(app), { ...WEB })

      const cookies = [result.resumed!.headers['set-cookie']].flat().join('\n').toLowerCase()
      expect(cookies).toMatch(/_session=[^;]+;[^\n]*samesite=none/)
      expect(cookies).toContain('secure')
      expect(cookies).toContain('httponly')
    })

    it('returns the code to the redirect URI with the state and issuer', async () => {
      const { callback, state } = await loginAs(WEB)

      expect(callback.origin + callback.pathname).toBe(WEB.redirectUri)
      expect(callback.searchParams.get('state')).toBe(state)
      expect(callback.searchParams.get('iss')).toBe(ISSUER)
    })

    it('exchanges the code for a signed ID token with the user and the allowed claims', async () => {
      const { browser, code, verifier, nonce } = await loginAs(WEB)

      const response = await exchangeCode(browser, WEB, code, verifier)
      const tokens = response.json()

      expect(response.statusCode).toBe(200)
      expect(tokens.token_type).toBe('Bearer')
      expect(tokens.access_token).toBeTruthy()
      const { valid, header, claims } = await verifyJwt(app, tokens.id_token)
      expect(valid).toBe(true)
      expect(header).toMatchObject({ alg: 'RS256', kid: 'test-key' })
      expect(claims).toMatchObject({
        iss: ISSUER,
        aud: 'demo-web',
        nonce,
        email: 'anna.schmidt@example.com',
        // partner_no is multi-valued: always an array, even with one value.
        partner_no: ['00892'],
      })
      expect(claims.sub).toMatch(/^[0-9a-f-]{36}$/)
      // demo-web is not allowed to receive these claim types.
      expect(claims).not.toHaveProperty('customer_no')
      expect(claims).not.toHaveProperty('branch_code')
    })

    it('returns several values of a multi-valued claim as an array', async () => {
      const browser = new Browser(app)
      const { code, verifier } = await signIn(browser, { ...WEB, email: 'ben.keller@example.com' })

      const tokens = (await exchangeCode(browser, WEB, code!, verifier)).json()

      expect((await verifyJwt(app, tokens.id_token)).claims.partner_no).toEqual(['00893', '00894'])
    })

    it('serves the same claims at the userinfo endpoint', async () => {
      const { browser, code, verifier } = await loginAs(WEB)
      const tokens = (await exchangeCode(browser, WEB, code, verifier)).json()

      const response = await browser.request('GET', '/me', { headers: { authorization: `Bearer ${tokens.access_token}` } })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ email: 'anna.schmidt@example.com', partner_no: ['00892'] })
      expect(response.json()).not.toHaveProperty('customer_no')
    })

    it('refuses the code with a wrong PKCE verifier', async () => {
      const { browser, code } = await loginAs(WEB)

      const response = await exchangeCode(browser, WEB, code, 'x'.repeat(43))

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('invalid_grant')
    })

    it('accepts a code only once', async () => {
      const { browser, code, verifier } = await loginAs(WEB)
      expect((await exchangeCode(browser, WEB, code, verifier)).statusCode).toBe(200)

      const replay = await exchangeCode(browser, WEB, code, verifier)

      expect(replay.statusCode).toBe(400)
      expect(replay.json().error).toBe('invalid_grant')
    })
  })

  describe('confidential client', () => {
    it('refuses a wrong secret and accepts the right one', async () => {
      const { browser, code, verifier } = await loginAs(BACKEND)

      const wrong = await exchangeCode(browser, BACKEND, code, verifier, { authorization: basicAuth('demo-backend', 'nope') })
      expect(wrong.statusCode).toBe(401)
      expect(wrong.json().error).toBe('invalid_client')

      const right = await exchangeCode(browser, BACKEND, code, verifier, {
        authorization: basicAuth('demo-backend', 'dev-secret'),
      })
      expect(right.statusCode).toBe(200)
    })

    describe('PKCE', () => {
      const withoutPkce = (clientId: string, redirectUri: string) =>
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: 'openid',
          state: 'abc',
        })

      it('is required by default, also for confidential clients', async () => {
        const response = await new Browser(app).request('GET', `/auth?${withoutPkce(BACKEND.clientId, BACKEND.redirectUri)}`)

        expect(new URL(response.headers.location as string).searchParams.get('error')).toBe('invalid_request')
      })

      it('can be switched off for one confidential client, which then signs in without a challenge', async () => {
        await database.pool.query(`update clients set pkce_required = false where client_id = 'demo-backend'`)
        await provider.reload()
        try {
          const browser = new Browser(app)
          const authorize = await browser.request('GET', `/auth?${withoutPkce(BACKEND.clientId, BACKEND.redirectUri)}`)
          expect(authorize.headers.location).toMatch(/^\/interaction\//)

          // The public client is unaffected.
          const publicResponse = await new Browser(app).request('GET', `/auth?${withoutPkce(WEB.clientId, WEB.redirectUri)}`)
          expect(new URL(publicResponse.headers.location as string).searchParams.get('error')).toBe('invalid_request')
        } finally {
          await database.pool.query(`update clients set pkce_required = true where client_id = 'demo-backend'`)
          await provider.reload()
        }
      })

      it('is still checked when a client that does not require it sends a challenge', async () => {
        await database.pool.query(`update clients set pkce_required = false where client_id = 'demo-backend'`)
        await provider.reload()
        try {
          const { browser, code } = await loginAs(BACKEND)
          const response = await exchangeCode(browser, BACKEND, code, 'x'.repeat(43), {
            authorization: basicAuth('demo-backend', 'dev-secret'),
          })

          expect(response.statusCode).toBe(400)
          expect(response.json().error).toBe('invalid_grant')
        } finally {
          await database.pool.query(`update clients set pkce_required = true where client_id = 'demo-backend'`)
          await provider.reload()
        }
      })
    })

    it('accepts the secret in the Authorization header or in the request body', async () => {
      const inHeader = await loginAs(BACKEND)
      const viaHeader = await exchangeCode(inHeader.browser, BACKEND, inHeader.code, inHeader.verifier, {
        authorization: basicAuth('demo-backend', 'dev-secret'),
      })
      expect(viaHeader.statusCode).toBe(200)

      const inBody = await loginAs(BACKEND)
      const viaBody = await inBody.browser.request('POST', '/token', {
        form: {
          grant_type: 'authorization_code',
          code: inBody.code,
          redirect_uri: BACKEND.redirectUri,
          client_id: BACKEND.clientId,
          client_secret: 'dev-secret',
          code_verifier: inBody.verifier,
        },
      })
      expect(viaBody.statusCode).toBe(200)

      const wrong = await loginAs(BACKEND)
      const refused = await wrong.browser.request('POST', '/token', {
        form: {
          grant_type: 'authorization_code',
          code: wrong.code,
          redirect_uri: BACKEND.redirectUri,
          client_id: BACKEND.clientId,
          client_secret: 'wrong',
          code_verifier: wrong.verifier,
        },
      })
      expect(refused.statusCode).toBe(401)
    })

    it('receives all claim types allowed for it, single-valued ones as strings', async () => {
      const { browser, code, verifier } = await loginAs(BACKEND)
      const tokens = (
        await exchangeCode(browser, BACKEND, code, verifier, { authorization: basicAuth('demo-backend', 'dev-secret') })
      ).json()

      const { claims } = await verifyJwt(app, tokens.id_token)

      expect(claims).toMatchObject({ partner_no: ['00892'], customer_no: '10001', branch_code: 'MUC' })
    })
  })

  describe('scopes', () => {
    const userinfoFor = async (scope: string) => {
      const { browser, code, verifier } = await loginAs(BACKEND, scope)
      const tokens = (
        await exchangeCode(browser, BACKEND, code, verifier, { authorization: basicAuth('demo-backend', 'dev-secret') })
      ).json()
      const userinfo = await browser.request('GET', '/me', { headers: { authorization: `Bearer ${tokens.access_token}` } })
      return { tokens, userinfo: userinfo.json(), status: userinfo.statusCode }
    }

    it.each([
      ['profile', ['name', 'given_name', 'family_name', 'locale']],
      ['email', ['email']],
      ['phone', ['phone_number', 'phone_number_verified']],
    ])('returns the %s claims at the userinfo endpoint when that scope is requested', async (scope, claims) => {
      const { userinfo, status, tokens } = await userinfoFor(`openid ${scope}`)

      expect(status).toBe(200)
      for (const claim of claims) expect(userinfo).toHaveProperty(claim)
      expect(tokens.scope).toContain(scope)
    })

    it('does not return profile or phone claims for a plain openid request', async () => {
      const { userinfo } = await userinfoFor('openid')

      expect(userinfo).not.toHaveProperty('name')
      expect(userinfo).not.toHaveProperty('phone_number')
      expect(userinfo).toHaveProperty('email')
    })

    it('grants an additional scope to a browser that is already signed in, without asking again', async () => {
      const browser = new Browser(app)
      const first = await signIn(browser, { ...WEB, scope: 'openid' })
      expect(first.code).toBeTruthy()

      // Same browser, same session, now asking for more scopes: no login page, no consent page.
      const { verifier, challenge } = pkcePair()
      const query = new URLSearchParams({
        client_id: WEB.clientId,
        redirect_uri: WEB.redirectUri,
        response_type: 'code',
        scope: 'openid profile phone',
        state: 'again',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })
      const response = await browser.request('GET', `/auth?${query}`)

      const location = new URL(response.headers.location as string, ISSUER)
      expect(location.pathname, 'should go straight back to the application').toBe('/callback')
      const code = location.searchParams.get('code')!
      const tokens = (await exchangeCode(browser, WEB, code, verifier)).json()
      expect(tokens.scope).toContain('profile')
      const userinfo = await browser.request('GET', '/me', { headers: { authorization: `Bearer ${tokens.access_token}` } })
      expect(userinfo.json()).toHaveProperty('name')
      expect(userinfo.json()).toHaveProperty('phone_number')
    })

    it('ignores a scope it does not support instead of failing, as the suite requests all scopes at once', async () => {
      const { userinfo, tokens, status } = await userinfoFor('openid profile email address phone')

      expect(status).toBe(200)
      expect(tokens.scope).not.toContain('address')
      expect(userinfo).toHaveProperty('name')
      expect(userinfo).toHaveProperty('phone_number')
      expect(userinfo).not.toHaveProperty('address')
    })
  })

  describe('authorization request parameters', () => {
    const query = (extra: Record<string, string> = {}, client = WEB) =>
      new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: client.redirectUri,
        response_type: 'code',
        scope: 'openid',
        state: 's1',
        nonce: 'n1',
        code_challenge: pkcePair().challenge,
        code_challenge_method: 'S256',
        ...extra,
      })
    const location = (response: { headers: Record<string, unknown> }) =>
      new URL(response.headers.location as string, ISSUER)

    it('prompt=none without a session answers login_required instead of showing a page', async () => {
      const response = await new Browser(app).request('GET', `/auth?${query({ prompt: 'none' })}`)

      const target = location(response)
      expect(target.origin + target.pathname).toBe(WEB.redirectUri)
      expect(target.searchParams.get('error')).toBe('login_required')
      expect(target.searchParams.get('state')).toBe('s1')
      expect(target.searchParams.get('code')).toBeNull()
    })

    it('prompt=none with a session returns a code without asking again', async () => {
      const { browser } = await loginAs(WEB)

      const response = await browser.request('GET', `/auth?${query({ prompt: 'none' })}`)

      expect(location(response).searchParams.get('code')).toBeTruthy()
    })

    it('prompt=login asks for the password again even though a session exists', async () => {
      const { browser } = await loginAs(WEB)

      const response = await browser.request('GET', `/auth?${query({ prompt: 'login' })}`)

      expect(location(response).pathname).toMatch(/^\/interaction\//)
    })

    it('max_age makes an old session sign in again and puts auth_time in the ID token', async () => {
      const { browser } = await loginAs(WEB)
      await new Promise((resolve) => setTimeout(resolve, 2200))

      const stale = await browser.request('GET', `/auth?${query({ max_age: '1' })}`)
      expect(location(stale).pathname, 'a session older than max_age must not be reused').toMatch(/^\/interaction\//)

      const verifierPair = pkcePair()
      const fresh = await browser.request('GET', `/auth?${query({ max_age: '10000', code_challenge: verifierPair.challenge })}`)
      const code = location(fresh).searchParams.get('code')
      expect(code).toBeTruthy()
      const tokens = (await exchangeCode(browser, WEB, code!, verifierPair.verifier)).json()
      expect((await verifyJwt(app, tokens.id_token)).claims.auth_time).toEqual(expect.any(Number))
    })

    it('accepts an id_token_hint from an earlier sign-in', async () => {
      const first = await loginAs(WEB)
      const tokens = (await exchangeCode(first.browser, WEB, first.code, first.verifier)).json()

      const response = await first.browser.request('GET', `/auth?${query({ id_token_hint: tokens.id_token })}`)

      expect(location(response).searchParams.get('code')).toBeTruthy()
    })

    it('shows the login_hint in the e-mail field', async () => {
      const browser = new Browser(app)
      const authorize = await browser.request('GET', `/auth?${query({ login_hint: 'hint@example.com' })}`)

      const page = await browser.request('GET', authorize.headers.location as string)

      expect(page.body).toContain('value="hint@example.com"')
    })

    it.each([
      ['an unknown parameter', { surprise: 'yes' }],
      ['display=page', { display: 'page' }],
      ['display=popup', { display: 'popup' }],
      ['ui_locales', { ui_locales: 'de en' }],
      ['claims_locales', { claims_locales: 'de en' }],
      ['acr_values', { acr_values: 'urn:example:acr' }],
    ])('ignores %s instead of failing', async (_name, extra) => {
      const { browser } = await loginAs(WEB)

      const response = await browser.request('GET', `/auth?${query(extra)}`)

      expect(location(response).searchParams.get('code')).toBeTruthy()
    })

    it('does not redirect to a redirect URI that is not registered', async () => {
      const response = await new Browser(app).request(
        'GET',
        `/auth?${query({ redirect_uri: 'https://evil.example.com/callback' })}`,
      )

      expect(response.statusCode).toBeGreaterThanOrEqual(400)
      expect(response.headers.location ?? '').not.toContain('evil.example.com')
    })

    it('also accepts the authorization request as an HTTP POST, as OpenID Connect requires', async () => {
      const response = await new Browser(app).request('POST', '/auth', { form: Object.fromEntries(query()) })

      expect(response.statusCode).toBe(303)
      expect(location(response).pathname).toMatch(/^\/interaction\//)
    })

    it('answers a request object with request_not_supported', async () => {
      const response = await new Browser(app).request('GET', `/auth?${query({ request: 'eyJhbGciOiJub25lIn0.e30.' })}`)

      expect(location(response).searchParams.get('error')).toBe('request_not_supported')
    })

    it('revokes the tokens of a code that is used twice', async () => {
      const { browser, code, verifier } = await loginAs(WEB)
      const tokens = (await exchangeCode(browser, WEB, code, verifier)).json()

      const replay = await exchangeCode(browser, WEB, code, verifier)
      expect(replay.statusCode).toBe(400)

      const userinfo = await browser.request('GET', '/me', { headers: { authorization: `Bearer ${tokens.access_token}` } })
      expect(userinfo.statusCode, 'the access token from the first use should be revoked').toBe(401)
    })
  })

  describe('refresh tokens', () => {
    const issueTokens = async () => {
      const { browser, code, verifier } = await loginAs(WEB, 'openid')
      return { browser, tokens: (await exchangeCode(browser, WEB, code, verifier)).json() }
    }
    const refresh = (browser: Browser, refreshToken: string) =>
      browser.request('POST', '/token', {
        form: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: 'demo-web' },
      })

    it('issues a refresh token without offline_access', async () => {
      const { tokens } = await issueTokens()
      expect(tokens.refresh_token).toBeTruthy()
    })

    it('rotates the refresh token on every use', async () => {
      const { browser, tokens } = await issueTokens()

      const response = await refresh(browser, tokens.refresh_token)
      const renewed = response.json()

      expect(response.statusCode).toBe(200)
      expect(renewed.refresh_token).toBeTruthy()
      expect(renewed.refresh_token).not.toBe(tokens.refresh_token)
      expect((await verifyJwt(app, renewed.id_token)).claims.partner_no).toEqual(['00892'])
    })

    it('revokes the whole grant when a used refresh token is replayed', async () => {
      const { browser, tokens } = await issueTokens()
      const renewed = (await refresh(browser, tokens.refresh_token)).json()

      const replay = await refresh(browser, tokens.refresh_token)
      expect(replay.statusCode).toBe(400)
      expect(replay.json().error).toBe('invalid_grant')

      // The token that replaced it is dead as well.
      const afterwards = await refresh(browser, renewed.refresh_token)
      expect(afterwards.statusCode).toBe(400)
      expect(afterwards.json().error).toBe('invalid_grant')
    })

    it('stops refreshing once the user is locked', async () => {
      const browser = new Browser(app)
      const { code, verifier } = await signIn(browser, { ...WEB, email: 'hans.weber@example.com' })
      const tokens = (await exchangeCode(browser, WEB, code!, verifier)).json()

      await database.pool.query(`update users set status = 'locked' where email = 'hans.weber@example.com'`)
      const response = await refresh(browser, tokens.refresh_token)

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('invalid_grant')
    })
  })

  describe('logout', () => {
    const idTokenFor = async (client: typeof WEB, headers = {}) => {
      const signedIn = await loginAs(client)
      const tokens = (await exchangeCode(signedIn.browser, client, signedIn.code, signedIn.verifier, headers)).json()
      return { browser: signedIn.browser, idToken: tokens.id_token as string }
    }

    it('ends the session after confirmation and returns to the post-logout URI', async () => {
      const { browser, idToken } = await idTokenFor(WEB)

      const confirm = await browser.request(
        'GET',
        `/session/end?${new URLSearchParams({ id_token_hint: idToken, post_logout_redirect_uri: 'http://localhost:3400/', state: 'bye' })}`,
      )
      expect(confirm.statusCode).toBe(200)
      const xsrf = /name="xsrf" value="([^"]+)"/.exec(confirm.body)?.[1]
      expect(xsrf).toBeTruthy()

      const done = await browser.request('POST', '/session/end/confirm', { form: { xsrf: xsrf!, logout: 'yes' } })
      expect(done.statusCode).toBe(303)
      expect(done.headers.location).toBe('http://localhost:3400/?state=bye')

      // The browser session is gone: a new authorization request asks for the login again.
      const query = new URLSearchParams({
        ...WEB.clientId && { client_id: WEB.clientId, redirect_uri: WEB.redirectUri },
        response_type: 'code',
        scope: 'openid',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
      })
      const again = await browser.request('GET', `/auth?${query}`)
      expect(again.headers.location).toMatch(/\/interaction\//)
    })

    describe('refresh tokens', () => {
      const refresh = (browser: Browser, refreshToken: string) =>
        browser.request('POST', '/token', {
          form: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: 'demo-web' },
        })

      const signInWithTokens = async (email: string) => {
        const browser = new Browser(app)
        const { code, verifier } = await signIn(browser, { ...WEB, email })
        const tokens = (await exchangeCode(browser, WEB, code!, verifier)).json()
        return { browser, tokens }
      }

      const startLogout = async (browser: Browser, idToken: string) => {
        const confirm = await browser.request('GET', `/session/end?${new URLSearchParams({ id_token_hint: idToken })}`)
        return /name="xsrf" value="([^"]+)"/.exec(confirm.body)![1]!
      }

      it('are revoked when the user signs out of the session', async () => {
        const { browser, tokens } = await signInWithTokens('ida.sommer@example.com')
        const xsrf = await startLogout(browser, tokens.id_token)

        await browser.request('POST', '/session/end/confirm', { form: { xsrf, logout: 'yes' } })

        const response = await refresh(browser, tokens.refresh_token)
        expect(response.statusCode).toBe(400)
        expect(response.json().error).toBe('invalid_grant')
      })

      it('are revoked when the user only signs out of the application', async () => {
        const { browser, tokens } = await signInWithTokens('jonas.fuchs@example.com')
        const xsrf = await startLogout(browser, tokens.id_token)

        // No "logout=yes": the user stays signed in at pforte but leaves this application.
        await browser.request('POST', '/session/end/confirm', { form: { xsrf } })

        const response = await refresh(browser, tokens.refresh_token)
        expect(response.statusCode).toBe(400)
        expect(response.json().error).toBe('invalid_grant')
      })

      it('of another device stay valid', async () => {
        const desktop = await signInWithTokens('carla.berger@example.com')
        const phone = await signInWithTokens('carla.berger@example.com')

        const xsrf = await startLogout(desktop.browser, desktop.tokens.id_token)
        await desktop.browser.request('POST', '/session/end/confirm', { form: { xsrf, logout: 'yes' } })

        expect((await refresh(desktop.browser, desktop.tokens.refresh_token)).statusCode).toBe(400)
        expect((await refresh(phone.browser, phone.tokens.refresh_token)).statusCode).toBe(200)
      })
    })

    it('refuses a post-logout redirect that is not registered', async () => {
      const { browser, idToken } = await idTokenFor(WEB)

      const response = await browser.request(
        'GET',
        `/session/end?${new URLSearchParams({ id_token_hint: idToken, post_logout_redirect_uri: 'https://evil.example.com/' })}`,
      )

      expect(response.statusCode).not.toBe(303)
      expect(response.headers.location ?? '').not.toContain('evil.example.com')
    })

    describe('back-channel', () => {
      let receiver: Server
      const received: string[] = []

      beforeAll(async () => {
        receiver = createServer((request, response) => {
          let body = ''
          request.on('data', (chunk) => (body += chunk))
          request.on('end', () => {
            received.push(body)
            response.writeHead(200).end()
          })
        })
        await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
        const { port } = receiver.address() as AddressInfo
        await database.pool.query(
          `update clients set backchannel_logout_uri = $1, backchannel_logout_session_required = true where client_id = 'demo-backend'`,
          [`http://127.0.0.1:${port}/logout`],
        )
        await provider.reload()
      })

      afterAll(() => new Promise<void>((resolve) => receiver.close(() => resolve())))

      it('posts a logout token to the client when the session ends', async () => {
        const { browser, idToken } = await idTokenFor(BACKEND, { authorization: basicAuth('demo-backend', 'dev-secret') })
        const confirm = await browser.request('GET', `/session/end?${new URLSearchParams({ id_token_hint: idToken })}`)
        const xsrf = /name="xsrf" value="([^"]+)"/.exec(confirm.body)?.[1]

        await browser.request('POST', '/session/end/confirm', { form: { xsrf: xsrf!, logout: 'yes' } })

        await expect.poll(() => received.length, { timeout: 5000 }).toBeGreaterThan(0)
        const logoutToken = new URLSearchParams(received.at(-1)).get('logout_token')!
        const { valid, claims } = await verifyJwt(app, logoutToken)
        expect(valid).toBe(true)
        expect(claims).toMatchObject({ iss: ISSUER, aud: 'demo-backend' })
        expect(claims.events).toHaveProperty('http://schemas.openid.net/event/backchannel-logout')
        expect(claims.sid).toBeTruthy()
      })
    })
  })
})
