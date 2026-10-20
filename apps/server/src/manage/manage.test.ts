import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sign } from '../interaction/signed-cookie.js'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { Browser, signIn } from '../test/browser.js'
import { isForThisSignIn, readIdToken, safeNext } from './oidc.js'

const COOKIE_KEYS = ['k'.repeat(40)]
const WEB = { clientId: 'demo-web', redirectUri: 'http://localhost:3400/callback' }

describe('where to go after signing in', () => {
  it.each([
    ['/manage', '/manage'],
    ['/manage/users?search=ada', '/manage/users?search=ada'],
    ['/manage/users/018f0000-0000-7000-8000-000000000000', '/manage/users/018f0000-0000-7000-8000-000000000000'],
  ])('keeps %s', (next, expected) => {
    expect(safeNext(next, '/manage')).toBe(expected)
  })

  it.each([undefined, '', 'https://evil.example', '//evil.example', '/managefoo', '/other', '/manage\\evil', '/manage /x', 'manage', 42])(
    'sends %s to the start page, so a sign-in cannot lead anywhere else',
    (next) => {
      expect(safeNext(next, '/manage')).toBe('/manage')
    },
  )
})

describe('the ID token of a sign-in', () => {
  const token = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`
  const expected = { issuer: 'https://id.example.com', clientId: 'pforte-admin-ui', nonce: 'n1' }
  const valid = { iss: 'https://id.example.com', aud: 'pforte-admin-ui', nonce: 'n1', exp: Math.floor(Date.now() / 1000) + 60 }

  it('is read from its payload, and nothing is read from what is not a token', () => {
    expect(readIdToken(token({ sub: 'u', acr: 'x' }))).toEqual({ sub: 'u', acr: 'x' })
    expect(readIdToken('nonsense')).toBeUndefined()
    expect(readIdToken('a.!!!.c')).toBeUndefined()
    expect(readIdToken(undefined)).toBeUndefined()
  })

  it('belongs to this sign-in when issuer, client, nonce and time fit', () => {
    expect(isForThisSignIn(valid, expected)).toBe(true)
    expect(isForThisSignIn({ ...valid, aud: ['other', 'pforte-admin-ui'] }, expected)).toBe(true)
  })

  it.each([
    ['another issuer', { iss: 'https://evil.example' }],
    ['another client', { aud: 'demo-web' }],
    ['another nonce', { nonce: 'n2' }],
    ['no nonce', { nonce: undefined }],
    ['an expired time', { exp: 1 }],
    ['no time', { exp: undefined }],
  ])('does not belong to it with %s', (_name, override) => {
    expect(isForThisSignIn({ ...valid, ...override }, expected)).toBe(false)
  })
})

describe.skipIf(!hasDatabase)('the administration UI: signing in and out', () => {
  let h: AdminHarness

  beforeAll(async () => {
    h = await createAdminHarness()
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(async () => {
    h.notifications.length = 0
    h.notifier.smsAvailable = false
    await h.database.pool.query('delete from rate_limits')
    await h.database.pool.query('delete from otp_codes')
    await h.database.pool.query('delete from devices')
    await h.database.pool.query(`update users set status = 'active', language = 'en' where email in ('admin@example.com', 'ben.keller@example.com')`)
  })

  const codesFor = (email: string) => h.notifications.filter((n) => n.kind === 'login-code' && n.user.email === email)

  /**
   * What a browser does from a first address: follows redirects, and where pforte asks for the password and the code,
   * enters them. Stops at the first page that is not a redirect and returns it.
   */
  const drive = async (browser: Browser, start: string, email = 'admin@example.com', { remember = false } = {}) => {
    let url = start
    const visited: string[] = []
    for (let step = 0; step < 14; step++) {
      const response = await browser.request('GET', url)
      visited.push(new URL(url, 'http://x').pathname)
      if (response.statusCode !== 303) return { response, visited }
      const location = response.headers.location as string
      const path = new URL(location, 'http://x').pathname
      if (/^\/interaction\/[^/]+$/.test(path)) {
        await browser.request('GET', location)
        const password = await browser.request('POST', `${path}/login`, { form: { email, password: 'dev-password' } })
        let next = password.headers.location as string
        if (next.endsWith('/code')) {
          const code = codesFor(email).at(-1)!.code!
          const done = await browser.request('POST', `${path}/code`, { form: { code, ...(remember ? { remember: 'on' } : {}) } })
          next = done.headers.location as string
        }
        url = next
        continue
      }
      url = location
    }
    throw new Error(`too many redirects: ${visited.join(' -> ')}`)
  }

  const setCookies = (response: { headers: Record<string, unknown> }) => [response.headers['set-cookie'] ?? []].flat().map(String)

  describe('before signing in', () => {
    it('sends a visitor to sign in, and remembers where they were going', async () => {
      const response = await new Browser(h.app).request('GET', '/manage?tab=1')
      expect(response.statusCode).toBe(303)
      expect(response.headers.location).toBe('/manage/login?next=%2Fmanage%3Ftab%3D1')
    })

    it('goes to the sign-in of pforte as an application does, with PKCE, and asks for the second factor', async () => {
      const browser = new Browser(h.app)
      const response = await browser.request('GET', '/manage/login?next=/manage')
      expect(response.statusCode).toBe(303)

      const url = new URL(response.headers.location as string)
      expect(`${url.origin}${url.pathname}`).toBe('https://localhost:3300/auth')
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        client_id: 'pforte-admin-ui',
        redirect_uri: 'https://localhost:3300/manage/callback',
        response_type: 'code',
        scope: 'openid profile',
        code_challenge_method: 'S256',
        acr_values: 'urn:pforte:acr:mfa',
      })
      expect(url.searchParams.get('state')).toHaveLength(22)
      expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(url.searchParams.has('prompt')).toBe(false)

      const cookie = setCookies(response).find((header) => header.startsWith('pforte_manage_login='))!
      expect(cookie).toMatch(/HttpOnly/i)
      expect(cookie).toMatch(/SameSite=Strict/i)
      expect(cookie).toMatch(/Path=\/manage/)
      expect(cookie).not.toContain(url.searchParams.get('code_challenge')!)
    })

    it('passes the languages of the browser on to the sign-in', async () => {
      const response = await new Browser(h.app).request('GET', '/manage/login', { headers: { 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' } })
      expect(new URL(response.headers.location as string).searchParams.get('ui_locales')).toBe('de-DE de en')
    })

    it('does not take a next address that leads somewhere else', async () => {
      const response = await new Browser(h.app).request('GET', '/manage/login?next=https://evil.example/manage')
      const cookie = setCookies(response).find((header) => header.startsWith('pforte_manage_login='))!
      expect(cookie).toBeDefined()
      // after signing in the person is brought to the start page, not to the other site
      const browser = new Browser(h.app)
      const { response: page, visited } = await drive(browser, '/manage/login?next=https://evil.example/manage')
      expect(page.statusCode).toBe(200)
      expect(visited.at(-1)).toBe('/manage')
    })
  })

  describe('signing in', () => {
    it('ends on the start page, with the person, their organisation and a way to sign out', async () => {
      const browser = new Browser(h.app)
      const { response, visited } = await drive(browser, '/manage')

      expect(visited.at(-1)).toBe('/manage')
      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('<html lang="en">')
      expect(response.body).toContain('Signed in as Ada Admin')
      expect(response.body).toContain('Example Inc.')
      expect(response.body).toContain('action="/manage/logout"')
      expect(response.body).toContain('<body class="manage">')
      expect(codesFor('admin@example.com')).toHaveLength(1)
    })

    it('keeps the person in a cookie that scripts cannot read and other sites cannot send', async () => {
      const browser = new Browser(h.app)
      const cookies: string[] = []
      let url = '/manage'
      for (let step = 0; step < 14; step++) {
        const response = await browser.request('GET', url)
        cookies.push(...setCookies(response))
        if (response.statusCode !== 303) break
        const location = response.headers.location as string
        const path = new URL(location, 'http://x').pathname
        if (/^\/interaction\/[^/]+$/.test(path)) {
          await browser.request('GET', location)
          await browser.request('POST', `${path}/login`, { form: { email: 'admin@example.com', password: 'dev-password' } })
          const done = await browser.request('POST', `${path}/code`, { form: { code: codesFor('admin@example.com').at(-1)!.code! } })
          url = done.headers.location as string
        } else url = location
      }

      const session = cookies.find((header) => header.startsWith('pforte_manage='))!
      expect(session).toBeDefined()
      expect(session).toMatch(/HttpOnly/i)
      expect(session).toMatch(/Secure/i)
      expect(session).toMatch(/SameSite=Strict/i)
      expect(session).toMatch(/Path=\/manage/)
      expect(session).toMatch(/Max-Age=\d+/)
      // the login state is done with
      expect(cookies.some((header) => header.startsWith('pforte_manage_login=;'))).toBe(true)
    })

    it('carries the strict policy of the pages and no caching', async () => {
      const browser = new Browser(h.app)
      const { response } = await drive(browser, '/manage')
      expect(response.headers['content-security-policy']).toContain("default-src 'none'")
      expect(response.headers['content-security-policy']).not.toContain('script-src')
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['x-frame-options']).toBe('DENY')
    })

    it('shows the page in the language of the administrator', async () => {
      await h.database.pool.query(`update users set language = 'de' where email = 'admin@example.com'`)
      const browser = new Browser(h.app)
      const { response } = await drive(browser, '/manage')
      expect(response.body).toContain('<html lang="de">')
      expect(response.body).toContain('Angemeldet als Ada Admin')
      expect(response.body).toContain('Abmelden')
    })

    it('shows names as text and never as markup', async () => {
      await h.database.pool.query(`update users set first_name = '<script>alert(1)</script>', last_name = '"><img src=x>' where email = 'admin@example.com'`)
      const { response } = await drive(new Browser(h.app), '/manage')
      expect(response.body).not.toContain('<script>alert(1)</script>')
      expect(response.body).not.toContain('<img src=x>')
      expect(response.body).toContain('&lt;script&gt;')
      await h.database.pool.query(`update users set first_name = 'Ada', last_name = 'Admin' where email = 'admin@example.com'`)
    })
  })

  describe('the second factor', () => {
    it('is asked for even when the browser has a remembered device and a session that did not need a code', async () => {
      const email = 'admin@example.com'
      const browser = new Browser(h.app)
      // first the code is entered once and the device remembered, in another application
      await drive(browser, `/auth?${new URLSearchParams({ client_id: WEB.clientId, redirect_uri: WEB.redirectUri, response_type: 'code', scope: 'openid', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' })}`, email, { remember: true })
      for (const name of browser.cookies.keys()) if (name !== 'pforte_device') browser.cookies.delete(name)
      // a later visit signs in with the password only; the session that results has no code behind it
      const weak = await signIn(browser, { ...WEB, email })
      expect(weak.code).toBeTruthy()
      const before = codesFor(email).length

      const { response, visited } = await drive(browser, '/manage')

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('Signed in as Ada Admin')
      // the weak session was noticed, a new sign-in was asked for, and it needed a code
      expect(codesFor(email).length).toBe(before + 1)
      expect(visited.filter((path) => path === '/manage/callback')).toHaveLength(2)
    })

    it('is not asked for twice when the single sign-on session already has a code behind it', async () => {
      const email = 'admin@example.com'
      const browser = new Browser(h.app)
      await drive(browser, '/manage', email)
      browser.cookies.delete('pforte_manage')
      const before = codesFor(email).length

      const { response } = await drive(browser, '/manage', email)

      expect(response.statusCode).toBe(200)
      expect(codesFor(email).length).toBe(before)
    })
  })

  describe('somebody who is not an administrator', () => {
    it('can sign in, but is told that the administration is not open to them, and gets no session', async () => {
      const browser = new Browser(h.app)
      const { response } = await drive(browser, '/manage', 'ben.keller@example.com')

      expect(response.statusCode).toBe(403)
      expect(response.body).toContain('Not an administrator')
      expect(response.body).toContain('Ben Keller')
      expect(response.body).not.toContain('Sign in</a>')
      expect(browser.cookies.has('pforte_manage')).toBe(false)
      expect((await browser.request('GET', '/manage')).statusCode).toBe(303)
    })
  })

  describe('a callback that does not belong to a sign-in', () => {
    it.each([
      ['without a sign-in having been started', '/manage/callback?code=abc&state=xyz'],
      ['with an error from pforte', '/manage/callback?error=access_denied&state=xyz'],
    ])('is refused %s', async (_name, url) => {
      const response = await new Browser(h.app).request('GET', url)
      expect(response.statusCode).toBe(400)
      expect(response.body).toContain('Signing in did not work')
    })

    it('is refused when the state does not match, so a link made by somebody else does not sign anybody in', async () => {
      const browser = new Browser(h.app)
      await browser.request('GET', '/manage/login')
      const response = await browser.request('GET', '/manage/callback?code=whatever&state=not-the-state')
      expect(response.statusCode).toBe(400)
      expect(browser.cookies.has('pforte_manage')).toBe(false)
    })

    it('is refused a second time, since the login state is used up', async () => {
      const browser = new Browser(h.app)
      let callback = ''
      let url = '/manage'
      for (let step = 0; step < 14; step++) {
        const response = await browser.request('GET', url)
        if (response.statusCode !== 303) break
        const location = response.headers.location as string
        const path = new URL(location, 'http://x').pathname
        if (path === '/manage/callback' || location.includes('/manage/callback?')) callback = location
        if (/^\/interaction\/[^/]+$/.test(path)) {
          await browser.request('GET', location)
          await browser.request('POST', `${path}/login`, { form: { email: 'admin@example.com', password: 'dev-password' } })
          const done = await browser.request('POST', `${path}/code`, { form: { code: codesFor('admin@example.com').at(-1)!.code! } })
          url = done.headers.location as string
        } else url = location
      }
      expect(callback).toContain('/manage/callback?')
      browser.cookies.delete('pforte_manage')
      expect((await browser.request('GET', callback)).statusCode).toBe(400)
    })
  })

  describe('the session cookie', () => {
    const session = (overrides: object = {}, keys = COOKIE_KEYS) =>
      sign(keys, { token: 'x', idToken: 'y', user: { id: 'u', name: 'N', language: 'en' }, expiresAt: Date.now() + 60_000, ...overrides })

    it('is not accepted when it was signed with another key, has run out, or is not signed at all', async () => {
      for (const value of [session({}, ['a-different-key-of-the-same-kind-0000']), session({ expiresAt: Date.now() - 1000 }), 'e30.nonsense', 'plain']) {
        const browser = new Browser(h.app)
        browser.cookies.set('pforte_manage', value)
        const response = await browser.request('GET', '/manage')
        expect(response.statusCode).toBe(303)
        expect(response.headers.location).toContain('/manage/login')
      }
    })

    it('is accepted when it is genuine and current', async () => {
      const browser = new Browser(h.app)
      browser.cookies.set('pforte_manage', session())
      const response = await browser.request('GET', '/manage')
      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('Signed in as N')
    })
  })

  describe('signing out', () => {
    it('clears the session and ends the sign-in of pforte too, so the next person on a shared computer cannot walk in', async () => {
      const browser = new Browser(h.app)
      await drive(browser, '/manage')

      const response = await browser.request('POST', '/manage/logout', { headers: { 'sec-fetch-site': 'same-origin' } })
      expect(response.statusCode).toBe(303)
      expect(setCookies(response).some((header) => header.startsWith('pforte_manage=;'))).toBe(true)

      const target = new URL(response.headers.location as string)
      expect(`${target.origin}${target.pathname}`).toBe('https://localhost:3300/session/end')
      expect(target.searchParams.get('post_logout_redirect_uri')).toBe('https://localhost:3300/manage/signed-out')
      expect(target.searchParams.get('id_token_hint')).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/)

      browser.cookies.delete('pforte_manage')
      expect((await browser.request('GET', '/manage')).statusCode).toBe(303)
    })

    it('shows a page that says so, with a way to sign in again', async () => {
      const response = await new Browser(h.app).request('GET', '/manage/signed-out')
      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('You are signed out')
      expect(response.body).toContain('href="/manage/login"')
    })

    it('is refused from another site', async () => {
      const browser = new Browser(h.app)
      await drive(browser, '/manage')
      const response = await browser.request('POST', '/manage/logout', { headers: { 'sec-fetch-site': 'cross-site' } })
      expect(response.statusCode).toBe(403)
      expect(browser.cookies.has('pforte_manage')).toBe(true)
    })

    it('works without a session too, by going to the page that says you are signed out', async () => {
      const response = await new Browser(h.app).request('POST', '/manage/logout')
      expect(response.statusCode).toBe(303)
      expect(response.headers.location).toBe('/manage/signed-out')
    })
  })
})
