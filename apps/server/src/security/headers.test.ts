import { hasDatabase } from '@progwise/pforte-db/testing'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { Browser, pkcePair } from '../test/browser.js'
import { addSecurityHeaders, securityHeaders } from './headers.js'
import { isForeignPost } from './origin-check.js'

describe('security headers', () => {
  it('say that data is not to be guessed at, that nothing is passed on in a referrer, that nothing may frame pforte, and that no device is needed', () => {
    const headers = securityHeaders(false)
    expect(headers).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    })
    expect(headers['Permissions-Policy']).toContain('camera=()')
    expect(headers['Permissions-Policy']).toContain('microphone=()')
  })

  it('add HSTS for a year over https, and only then, without subdomains or preload', () => {
    expect(securityHeaders(false)).not.toHaveProperty('Strict-Transport-Security')
    const hsts = (securityHeaders(true) as Record<string, string>)['Strict-Transport-Security']
    expect(hsts).toBe('max-age=31536000')
    expect(hsts).not.toMatch(/includeSubDomains|preload/i)
  })

  it('leave out the opener policy, which would break sign-in in a popup', () => {
    expect(Object.keys(securityHeaders(true))).not.toContain('Cross-Origin-Opener-Policy')
  })

  it('are on every answer, including those of a route that is not found', async () => {
    const app = Fastify()
    addSecurityHeaders(app, { https: true })
    app.get('/x', async () => 'ok')
    for (const url of ['/x', '/nothing-here']) {
      const response = await app.inject({ url })
      expect(response.headers['x-content-type-options']).toBe('nosniff')
      expect(response.headers['strict-transport-security']).toBe('max-age=31536000')
    }
  })

  it('are set by buildApp from the issuer', async () => {
    const secure = buildApp({ getDatabaseTime: async () => new Date(), issuer: 'https://id.example.com' })
    const local = buildApp({ getDatabaseTime: async () => new Date(), issuer: 'http://localhost:3300' })
    expect((await secure.inject({ url: '/health' })).headers['strict-transport-security']).toBeDefined()
    expect((await local.inject({ url: '/health' })).headers['strict-transport-security']).toBeUndefined()
    expect((await local.inject({ url: '/health' })).headers['x-frame-options']).toBe('DENY')
  })
})

describe('where a form post came from', () => {
  const post = (headers: Record<string, string>) => ({ headers }) as never
  const issuer = 'https://id.example.com'

  it('is our own page when the browser says same-origin', () => {
    expect(isForeignPost(post({ 'sec-fetch-site': 'same-origin' }), issuer)).toBe(false)
  })

  it.each(['cross-site', 'same-site', 'none'])('is somebody else when the browser says %s', (site) => {
    expect(isForeignPost(post({ 'sec-fetch-site': site }), issuer)).toBe(true)
  })

  it('goes by Origin when the browser does not send Sec-Fetch-Site', () => {
    expect(isForeignPost(post({ origin: 'https://id.example.com' }), issuer)).toBe(false)
    expect(isForeignPost(post({ origin: 'https://evil.example' }), issuer)).toBe(true)
    expect(isForeignPost(post({ origin: 'https://id.example.com.evil.example' }), issuer)).toBe(true)
    expect(isForeignPost(post({ origin: 'http://id.example.com' }), issuer)).toBe(true)
    expect(isForeignPost(post({ origin: 'null' }), issuer)).toBe(true)
    expect(isForeignPost(post({ origin: 'not an address' }), issuer)).toBe(true)
  })

  it('trusts Sec-Fetch-Site over a conflicting Origin, as the browser, not the page, writes it', () => {
    expect(isForeignPost(post({ 'sec-fetch-site': 'cross-site', origin: 'https://id.example.com' }), issuer)).toBe(true)
  })

  it('is not a browser at all when there is neither, so there is nothing to be tricked', () => {
    expect(isForeignPost(post({}), issuer)).toBe(false)
  })
})

describe.skipIf(!hasDatabase)('forms of pforte', () => {
  let h: AdminHarness

  beforeAll(async () => {
    h = await createAdminHarness()
  })

  afterAll(async () => {
    await h?.close()
  })

  const start = async (locale = 'en') => {
    const browser = new Browser(h.app)
    const query = new URLSearchParams({
      client_id: 'demo-web',
      redirect_uri: 'http://localhost:3400/callback',
      response_type: 'code',
      scope: 'openid',
      state: 's',
      nonce: 'n',
      ui_locales: locale,
      code_challenge: pkcePair().challenge,
      code_challenge_method: 'S256',
    })
    const interaction = (await browser.request('GET', `/auth?${query}`)).headers.location as string
    await browser.request('GET', interaction)
    return { browser, interaction }
  }
  const login = (s: Awaited<ReturnType<typeof start>>, headers: Record<string, string>) =>
    s.browser.request('POST', `${s.interaction}/login`, { form: { email: 'anna.schmidt@example.com', password: 'dev-password' }, headers })

  it('refuse a post from another site before anything happens, in the language of the page', async () => {
    const before = (await h.database.pool.query(`select count(*) from rate_limits`)).rows[0].count
    const s = await start('de')

    const response = await login(s, { 'sec-fetch-site': 'cross-site', 'accept-language': 'de' })
    expect(response.statusCode).toBe(403)
    expect(response.body).toContain('Anfrage abgelehnt')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(h.notifications).toHaveLength(0)
    expect((await h.database.pool.query(`select count(*) from rate_limits`)).rows[0].count).toBe(before)
  })

  it('refuse every kind of foreign post to the sign-in, the code and the account pages', async () => {
    const s = await start()
    const foreign = { 'sec-fetch-site': 'cross-site' }
    for (const [url, form] of [
      [`${s.interaction}/login`, { email: 'a@b.c', password: 'x' }],
      [`${s.interaction}/code`, { code: '123456' }],
      [`${s.interaction}/code/resend`, {}],
      [`${s.interaction}/abort`, {}],
      ['/reset', { email: 'greta.lang@example.com' }],
      ['/reset/code', { email: 'a@b.c', code: '1', password: 'x', confirm: 'x' }],
      ['/activate', { token: 'x', password: 'x', confirm: 'x' }],
      ['/activate/phone', { code: '123456' }],
      ['/activate/phone/skip', {}],
    ] as const) {
      const response = await s.browser.request('POST', url, { form: { ...form }, headers: foreign })
      expect(response.statusCode, url).toBe(403)
    }
    expect(h.notifications).toHaveLength(0)
  })

  it('accept a post from their own page, with either header, or from a tool that sends neither', async () => {
    await h.database.pool.query('delete from rate_limits')
    const s = await start()
    expect((await login(s, { 'sec-fetch-site': 'same-origin' })).statusCode).toBe(303)
    const t = await start()
    expect((await login(t, { origin: 'https://localhost:3300' })).statusCode).toBe(303)
    const u = await start()
    expect((await login(u, {})).statusCode).toBe(303)
  })

  it('refuse a post whose Origin is another site, or "null"', async () => {
    const s = await start()
    expect((await login(s, { origin: 'https://evil.example' })).statusCode).toBe(403)
    expect((await login(s, { origin: 'null' })).statusCode).toBe(403)
  })

  it('do not hold back a person who follows a link from another site to a page (a GET)', async () => {
    const mail = await new Browser(h.app).request('GET', '/activate?token=anything', { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(mail.statusCode).toBe(400) // the link is not valid, but the request was not refused for where it came from
    expect((await new Browser(h.app).request('GET', '/reset', { headers: { 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(200)
  })

  it('do not touch the endpoints of the OpenID provider, which applications call from their own sites', async () => {
    const response = await new Browser(h.app).request('POST', '/token', {
      form: { grant_type: 'authorization_code', code: 'x' },
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://app.example' },
    })
    // The provider answers as it sees fit (here: no client authentication); pforte's own check did not refuse it.
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'invalid_request' })
  })

  it('carry the security headers, also on answers the provider writes itself', async () => {
    for (const url of ['/.well-known/openid-configuration', '/jwks', '/reset', '/health']) {
      const response = await new Browser(h.app).request('GET', url)
      expect(response.headers['x-content-type-options'], url).toBe('nosniff')
      expect(response.headers['strict-transport-security'], url).toBe('max-age=31536000')
      expect(response.headers['x-frame-options'], url).toBe('DENY')
      expect(response.headers['referrer-policy'], url).toBe('no-referrer')
      expect(response.headers['cross-origin-opener-policy'], url).toBeUndefined()
    }
    const api = await h.api('GET', '/users?limit=1')
    expect(api.headers['x-content-type-options']).toBe('nosniff')
    expect(api.headers['strict-transport-security']).toBeDefined()
  })

  it('give every cookie of a sign-in HttpOnly, Secure and a SameSite value', async () => {
    const cookies: string[] = []
    const keep = (response: { headers: Record<string, unknown> }) => cookies.push(...[response.headers['set-cookie'] ?? []].flat().map(String))
    const s = await start()
    keep(await s.browser.request('GET', s.interaction))
    const password = await s.browser.request('POST', `${s.interaction}/login`, { form: { email: 'anna.schmidt@example.com', password: 'dev-password' } })
    keep(password)
    const code = h.notifications.findLast((n) => n.kind === 'login-code')!.code!
    const done = await s.browser.request('POST', `${s.interaction}/code`, { form: { code, remember: 'on' } })
    keep(done)
    keep(await s.browser.request('GET', done.headers.location as string))

    expect(cookies.length).toBeGreaterThan(5)
    const names = cookies.map((cookie) => cookie.split('=')[0]!.trim())
    expect(names).toEqual(expect.arrayContaining(['pforte_second_factor', 'pforte_device', '_session']))
    for (const cookie of cookies) {
      expect(cookie, cookie.slice(0, 40)).toMatch(/;\s*httponly/i)
      expect(cookie, cookie.slice(0, 40)).toMatch(/;\s*secure/i)
      expect(cookie, cookie.slice(0, 40)).toMatch(/;\s*samesite=(strict|lax|none)/i)
    }
    // our own cookies never leave the site
    for (const cookie of cookies.filter((c) => c.startsWith('pforte_'))) expect(cookie).toMatch(/samesite=strict/i)
  })
})
