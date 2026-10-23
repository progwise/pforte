import { generateKeyPairSync } from 'node:crypto'
import { getDatabaseTime } from '@progwise/pforte-db'
import { seed } from '@progwise/pforte-db/seed'
import { createTestDatabase, hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { createAuthenticate } from '../auth/authenticate.js'
import { createLoginAudit } from '../auth/login-audit.js'
import { createRateLimiter } from '../auth/rate-limiter.js'
import { createUi } from '../ui/index.js'
import { createRecordingNotifier } from '../test/recording-notifier.js'
import { createProviderHolder } from './provider.js'

const testJwks = () => {
  const jwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' })
  return { keys: [{ ...jwk, kty: 'RSA', kid: 'test-key', alg: 'RS256', use: 'sig' }] }
}

// The seeded clients: demo-web (public) has the redirect URI http://localhost:3400/callback.
const registered = 'http://localhost:3400'
const stranger = 'https://evil.example'

describe.skipIf(!hasDatabase)('CORS', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof buildApp>

  beforeAll(async () => {
    database = await createTestDatabase()
    await seed(database.db)
    const oidc = await createProviderHolder({
      config: { issuer: 'http://localhost:3300', cookieKeys: ['k'.repeat(40)], jwks: testJwks() },
      db: database.db,
    })
    app = buildApp({
      getDatabaseTime: () => getDatabaseTime(database.db),
      oidc: {
        provider: oidc,
        authenticate: await createAuthenticate(database.db),
        db: database.db,
        notifier: createRecordingNotifier().notifier,
        cookieKeys: ['k'.repeat(40)],
        ui: createUi(),
        limiter: createRateLimiter({ db: database.db, secret: 'rate-limit-test-secret' }),
        audit: createLoginAudit({ db: database.db, secret: 'audit-test-secret' }),
      },
    })
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
    await database?.drop()
  })

  const allowOrigin = (headers: Record<string, unknown>) => headers['access-control-allow-origin']
  const noCorsHeaders = (headers: Record<string, unknown>) =>
    Object.keys(headers).filter((name) => name.startsWith('access-control-'))

  const preflight = (url: string, origin: string) =>
    app.inject({
      method: 'OPTIONS',
      url,
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    })

  const tokenRequest = (origin: string | undefined, clientId = 'demo-web') =>
    app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin && { origin }) },
      payload: `grant_type=authorization_code&code=nope&redirect_uri=${encodeURIComponent(`${registered}/callback`)}&code_verifier=${'a'.repeat(43)}&client_id=${clientId}`,
    })

  describe('discovery and keys', () => {
    it.each(['/.well-known/openid-configuration', '/jwks'])('%s is readable from any page, without reflecting the origin', async (url) => {
      for (const origin of [registered, stranger, 'null']) {
        const response = await app.inject({ method: 'GET', url, headers: { origin } })
        expect(response.statusCode).toBe(200)
        expect(allowOrigin(response.headers)).toBe('*')
        expect(response.headers['access-control-allow-credentials']).toBeUndefined()
      }
    })

    it.each(['/.well-known/openid-configuration', '/jwks'])('%s answers a preflight request with *', async (url) => {
      const response = await app.inject({ method: 'OPTIONS', url, headers: { origin: stranger, 'access-control-request-method': 'GET' } })
      expect(response.statusCode).toBe(204)
      expect(allowOrigin(response.headers)).toBe('*')
      expect(response.headers['access-control-allow-credentials']).toBeUndefined()
    })
  })

  describe('token endpoint', () => {
    it('answers a preflight request from the origin of a registered redirect URI', async () => {
      const response = await preflight('/token', registered)
      expect(response.statusCode).toBe(204)
      expect(allowOrigin(response.headers)).toBe(registered)
      expect(response.headers['access-control-allow-methods']).toBe('POST')
      expect(response.headers['access-control-allow-credentials']).toBeUndefined()
    })

    it.each([stranger, 'null', 'http://localhost:3401'])('gives a preflight request from %s no CORS headers', async (origin) => {
      const response = await preflight('/token', origin)
      expect(response.statusCode).toBe(204)
      expect(noCorsHeaders(response.headers)).toEqual([])
    })

    it('lets the registered origin of the client read the answer, errors included', async () => {
      const response = await tokenRequest(registered)
      expect(response.statusCode).toBe(400)
      expect(allowOrigin(response.headers)).toBe(registered)
      expect(response.headers['access-control-allow-credentials']).toBeUndefined()
    })

    it('does not let another origin read the answer', async () => {
      for (const origin of [stranger, 'null']) {
        const response = await tokenRequest(origin)
        expect(noCorsHeaders(response.headers)).toEqual([])
      }
    })

    it('does not let the origin of one client call as another client', async () => {
      // demo-backend is registered for http://localhost:3500 only, and is confidential.
      const response = await tokenRequest(registered, 'demo-backend')
      expect(noCorsHeaders(response.headers)).toEqual([])
    })

    it('sends no CORS headers without an Origin, or for an unknown client', async () => {
      expect(noCorsHeaders((await tokenRequest(undefined)).headers)).toEqual([])
      expect(noCorsHeaders((await tokenRequest(registered, 'nobody')).headers)).toEqual([])
    })
  })

  describe('userinfo endpoint', () => {
    it('answers a preflight request from a registered origin only', async () => {
      expect(allowOrigin((await preflight('/me', registered)).headers)).toBe(registered)
      expect(noCorsHeaders((await preflight('/me', stranger)).headers)).toEqual([])
    })

    it('sends no CORS headers when the token is missing or wrong', async () => {
      for (const origin of [registered, stranger]) {
        const response = await app.inject({ method: 'GET', url: '/me', headers: { origin, authorization: 'Bearer nope' } })
        expect(response.statusCode).toBe(401)
        expect(noCorsHeaders(response.headers)).toEqual([])
      }
    })
  })

  describe('everything else', () => {
    it.each([
      ['GET', '/health'],
      ['GET', '/admin/whoami'],
      ['GET', '/manage'],
      ['GET', '/interaction/nope'],
      ['GET', '/auth?client_id=demo-web'],
      ['GET', '/session/end'],
    ])('%s %s sends no CORS headers', async (method, url) => {
      for (const origin of [registered, stranger]) {
        const response = await app.inject({ method: method as 'GET', url, headers: { origin } })
        expect(noCorsHeaders(response.headers)).toEqual([])
      }
    })

    it('does not answer a preflight request for the admin API', async () => {
      const response = await preflight('/admin/users', registered)
      expect(noCorsHeaders(response.headers)).toEqual([])
    })
  })
})
