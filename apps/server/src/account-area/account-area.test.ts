import { createTestDatabase, hasDatabase } from '@progwise/pforte-db/testing'
import Fastify from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sign, unsign } from '../interaction/signed-cookie.js'
import { type AdminHarness, createAdminHarness, ISSUER } from '../test/admin-harness.js'
import { Browser, signIn } from '../test/browser.js'
import { driveSignIn } from '../test/manage-session.js'
import { ACCOUNT_UI_CLIENT_ID } from './constants.js'
import { accountAreaRoutes } from './routes.js'
import { ensureAccountUiClient } from './setup.js'

const COOKIE_KEYS = ['k'.repeat(40)]
const WEB = { clientId: 'demo-web', redirectUri: 'http://localhost:3400/callback' }
/** Two people of the seed. Whatever one of them sees or does must never be the other's. */
const A = { email: 'anna.schmidt@example.com', name: 'Anna Schmidt' }
const B = { email: 'ben.keller@example.com', name: 'Ben Keller' }

describe.skipIf(!hasDatabase)('the account pages', () => {
  let h: AdminHarness

  beforeAll(async () => {
    h = await createAdminHarness()
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(async () => {
    h.notifications.length = 0
    await h.database.pool.query('delete from rate_limits')
    await h.database.pool.query('delete from otp_codes')
    await h.database.pool.query('delete from devices')
    await h.database.pool.query(`update users set status = 'active', locked_at = null where email in ($1, $2)`, [A.email, B.email])
    await h.database.pool.query(`update users set language = 'de' where email = $1`, [A.email])
    await h.database.pool.query(`update users set language = 'en' where email = $1`, [B.email])
  })

  const idOf = async (email: string) => (await h.database.pool.query(`select id from users where email = $1`, [email])).rows[0].id as string
  const codesFor = (email: string) => h.notifications.filter((n) => n.kind === 'login-code' && n.user.email === email)
  const setCookies = (response: { headers: Record<string, unknown> }) => [response.headers['set-cookie'] ?? []].flat().map(String)
  /** A browser in which this person is signed in to their account pages. */
  const signedIn = async (email: string) => {
    const browser = new Browser(h.app)
    const { response } = await driveSignIn(h, browser, '/account', email)
    expect(response.statusCode, response.body).toBe(200)
    return browser
  }

  describe('before signing in', () => {
    it('shows nothing and sends the visitor to sign in, remembering where they were going', async () => {
      const response = await new Browser(h.app).request('GET', '/account')
      expect(response.statusCode).toBe(303)
      expect(response.headers.location).toBe('/account/login?next=%2Faccount')
      expect(response.body).toBe('')
    })

    it('goes to the sign-in of pforte as an application does, with PKCE, asking for the second factor and for nothing but openid', async () => {
      const response = await new Browser(h.app).request('GET', '/account/login', { headers: { 'accept-language': 'hu, de;q=0.8' } })
      expect(response.statusCode).toBe(303)
      const target = new URL(response.headers.location as string)
      expect(`${target.origin}${target.pathname}`).toBe(`${ISSUER}/auth`)
      expect(Object.fromEntries(target.searchParams)).toMatchObject({
        client_id: ACCOUNT_UI_CLIENT_ID,
        redirect_uri: `${ISSUER}/account/callback`,
        response_type: 'code',
        scope: 'openid',
        code_challenge_method: 'S256',
        acr_values: 'urn:pforte:acr:mfa',
        ui_locales: 'hu de',
      })
      expect(target.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/)
    })

    it.each(['https://evil.example/account', '//evil.example', '/manage/users', '/accountant', '/account\\x'])('does not take %s as the address to return to', async (next) => {
      const browser = new Browser(h.app)
      const { response, visited } = await driveSignIn(h, browser, `/account/login?next=${encodeURIComponent(next)}`, A.email)
      expect(response.statusCode).toBe(200)
      expect(visited.at(-1)).toBe('/account')
    })
  })

  describe('signing in', () => {
    it('ends on the start page with the person, read-only, and a way to sign out', async () => {
      const browser = new Browser(h.app)
      const { response, visited } = await driveSignIn(h, browser, '/account', B.email)

      expect(response.statusCode).toBe(200)
      expect(visited.at(-1)).toBe('/account')
      expect(response.body).toContain('<h1>Your account</h1>')
      expect(response.body).toContain('Signed in as Ben Keller')
      expect(response.body).toContain(`<dd>${B.email}</dd>`)
      expect(response.body).toContain('<dd>English</dd>')
      expect(response.body).toContain('action="/account/logout"')
      // Read-only: the only form on the page is the one that signs out.
      expect(response.body.match(/<form/g)).toHaveLength(1)
      expect(response.body).not.toMatch(/<input|<textarea|<select/)
    })

    it('hides most of the phone number: the page may be read over a shoulder', async () => {
      const browser = await signedIn(B.email)
      const phone = (await h.database.pool.query(`select phone from users where email = $1`, [B.email])).rows[0].phone as string
      const page = await browser.request('GET', '/account')
      expect(phone).toMatch(/^\+\d{8,}$/)
      expect(page.body).not.toContain(phone)
      expect(page.body).toContain(`${phone.slice(0, 3)}•`)
      expect(page.body).toContain(`•${phone.slice(-2)}</dd>`)
    })

    it('needed a code', async () => {
      await signedIn(A.email)
      expect(codesFor(A.email)).toHaveLength(1)
    })

    it('keeps who it is in a cookie that scripts cannot read, that lasts an hour and holds no token', async () => {
      const browser = new Browser(h.app)
      let cookie: string | undefined
      let url = '/account'
      // Followed by hand to see the answer that sets the cookie.
      for (let step = 0; step < 14 && !cookie; step++) {
        const response = await browser.request('GET', url)
        cookie = setCookies(response).find((header) => header.startsWith('pforte_account=') && !header.startsWith('pforte_account=;'))
        const location = response.headers.location as string
        const path = new URL(location, 'http://x').pathname
        if (/^\/interaction\/[^/]+$/.test(path)) {
          await browser.request('GET', location)
          await browser.request('POST', `${path}/login`, { form: { email: A.email, password: 'dev-password' } })
          url = (await browser.request('POST', `${path}/code`, { form: { code: codesFor(A.email).at(-1)!.code! } })).headers.location as string
        } else url = location
      }

      expect(cookie).toBeDefined()
      const attributes = cookie!.split('; ').slice(1)
      expect(attributes).toEqual(expect.arrayContaining(['Path=/account', 'Max-Age=3600', 'HttpOnly', 'SameSite=Lax', 'Secure']))
      const session = unsign<Record<string, unknown>>(COOKIE_KEYS, cookie!.split(';')[0]!.split('=')[1])!
      expect(Object.keys(session).sort()).toEqual(['acr', 'authTime', 'expiresAt', 'grantId', 'userId'])
      expect(session).toMatchObject({ userId: await idOf(A.email), acr: 'urn:pforte:acr:mfa' })
      expect(Math.abs((session.authTime as number) - Date.now() / 1000)).toBeLessThan(60)
    })

    it('carries the strict policy of the pages, no caching and no framing', async () => {
      const browser = await signedIn(A.email)
      const page = await browser.request('GET', '/account')
      expect(page.headers['cache-control']).toBe('no-store')
      expect(page.headers['x-frame-options']).toBe('DENY')
      // Nothing loads unless the policy names it, and it names no script.
      expect(page.headers['content-security-policy']).toContain("default-src 'none'")
      expect(page.headers['content-security-policy']).not.toContain('script-src')
      expect(page.body).not.toContain('<script')
    })

    it.each([
      ['de', 'Ihr Konto', 'Angemeldet als Ben Keller'],
      ['fr', 'Votre compte', 'Connecté en tant que Ben Keller'],
      ['hu', 'Az Ön fiókja', 'Bejelentkezve: Ben Keller'],
    ])('shows the pages in the language of the person: %s', async (language, title, signedInAs) => {
      await h.database.pool.query(`update users set language = $2 where email = $1`, [B.email, language])
      const browser = await signedIn(B.email)
      const page = await browser.request('GET', '/account', { headers: { 'accept-language': 'en' } })
      expect(page.body).toContain(`<html lang="${language}">`)
      expect(page.body).toContain(`<h1>${title}</h1>`)
      expect(page.body).toContain(signedInAs)
    })

    it('shows names as text and never as markup', async () => {
      await h.database.pool.query(`update users set first_name = '<img src=x onerror=alert(1)>' where email = $1`, [B.email])
      try {
        const browser = await signedIn(B.email)
        const page = await browser.request('GET', '/account')
        expect(page.body).not.toContain('<img src=x')
        expect(page.body).toContain('&lt;img src=x onerror=alert(1)&gt; Keller')
      } finally {
        await h.database.pool.query(`update users set first_name = 'Ben' where email = $1`, [B.email])
      }
    })
  })

  describe('one person never sees another', () => {
    it('shows each of two people only themselves', async () => {
      const [browserA, browserB] = [await signedIn(A.email), await signedIn(B.email)]
      const [pageA, pageB] = [await browserA.request('GET', '/account'), await browserB.request('GET', '/account')]

      expect(pageA.body).toContain(A.email)
      expect(pageA.body).toContain(A.name)
      expect(pageA.body).not.toContain(B.email)
      expect(pageA.body).not.toContain('Keller')

      expect(pageB.body).toContain(B.email)
      expect(pageB.body).toContain(B.name)
      expect(pageB.body).not.toContain(A.email)
      expect(pageB.body).not.toContain('Schmidt')
    })

    it.each([
      ['an address parameter', (id: string) => ({ url: `/account?user=${id}&userId=${id}&id=${id}&sub=${id}`, headers: {} })],
      ['a header', (id: string) => ({ url: '/account', headers: { 'x-user-id': id, 'x-forwarded-user': id } })],
    ])('takes nobody else from %s', async (_name, request) => {
      const browser = await signedIn(A.email)
      const { url, headers } = request(await idOf(B.email))
      const page = await browser.request('GET', url, { headers })
      expect(page.statusCode).toBe(200)
      expect(page.body).toContain(A.email)
      expect(page.body).not.toContain(B.email)
    })

    it('has no address that carries an id: there is nothing to change into somebody else', async () => {
      const routes: string[] = []
      const app = Fastify()
      app.addHook('onRoute', (route) => {
        routes.push(route.url)
      })
      await app.register(accountAreaRoutes(h.accountArea))
      await app.ready()
      await app.close()

      const account = routes.filter((url) => url.startsWith('/account'))
      expect(account).toEqual(
        expect.arrayContaining([
          '/account',
          '/account/login',
          '/account/callback',
          '/account/logout',
          '/account/signed-out',
          '/account/sessions',
          '/account/sessions/end',
          '/account/devices',
          '/account/devices/forget',
          '/account/devices/forget-all',
          '/account/sign-ins',
          '/account/password',
          '/account/passkeys',
          '/account/passkeys/new',
          '/account/passkeys/remove',
        ]),
      )
      // Nothing the area serves lies outside it, and no address has a part that is filled in: `:id`, `*`, a pattern.
      expect(routes).toEqual(account)
      expect(account.filter((url) => /[:*(]/.test(url))).toEqual([])
    })
  })

  describe('the second factor', () => {
    it('is asked for even when the browser has a remembered device and a session that did not need a code', async () => {
      const browser = new Browser(h.app)
      const authorize = `/auth?${new URLSearchParams({ client_id: WEB.clientId, redirect_uri: WEB.redirectUri, response_type: 'code', scope: 'openid', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' })}`
      await driveSignIn(h, browser, authorize, A.email, { remember: true })
      for (const name of browser.cookies.keys()) if (name !== 'pforte_device') browser.cookies.delete(name)
      const weak = await signIn(browser, { ...WEB, email: A.email })
      expect(weak.code).toBeTruthy()
      const before = codesFor(A.email).length

      const { response, visited } = await driveSignIn(h, browser, '/account', A.email)

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('Angemeldet als Anna Schmidt')
      expect(codesFor(A.email).length).toBe(before + 1)
      expect(visited.filter((path) => path === '/account/callback')).toHaveLength(2)
    })

    it('is not asked for twice when the single sign-on session already has a code behind it', async () => {
      const browser = await signedIn(A.email)
      browser.cookies.delete('pforte_account')
      const before = codesFor(A.email).length

      const { response } = await driveSignIn(h, browser, '/account', A.email)

      expect(response.statusCode).toBe(200)
      expect(codesFor(A.email).length).toBe(before)
    })
  })

  describe('the session cookie', () => {
    const cookieFor = async (email: string, overrides: object = {}, keys = COOKIE_KEYS) =>
      sign(keys, { userId: await idOf(email), grantId: 'no-such-grant', acr: 'urn:pforte:acr:mfa', authTime: Math.floor(Date.now() / 1000), expiresAt: Date.now() + 60_000, ...overrides })
    /** What the session cookie of a browser says. */
    const sessionIn = (browser: Browser) => unsign<{ userId: string; grantId: string }>(COOKIE_KEYS, browser.cookies.get('pforte_account'))!
    /** Another browser that holds a copy of this one's session cookie, as a thief would. */
    const copyOf = (browser: Browser) => {
      const copy = new Browser(h.app)
      copy.cookies.set('pforte_account', browser.cookies.get('pforte_account')!)
      return copy
    }
    const refused = async (browser: Browser) => {
      const response = await browser.request('GET', '/account')
      expect(response.statusCode).toBe(303)
      expect(response.headers.location).toBe('/account/login?next=%2Faccount')
      expect(response.body).toBe('')
      expect(setCookies(response).some((header) => header.startsWith('pforte_account=;'))).toBe(true)
    }

    it('is not accepted when it was signed with another key, has run out, or is not signed at all', async () => {
      // With the grant of a real sign-in, so that only the thing named can be what refuses it.
      const { grantId } = sessionIn(await signedIn(A.email))
      for (const value of [await cookieFor(A.email, { grantId }, ['a-different-key-of-the-same-kind-0000']), await cookieFor(A.email, { grantId, expiresAt: Date.now() - 1000 }), 'e30.nonsense', 'plain']) {
        const browser = new Browser(h.app)
        browser.cookies.set('pforte_account', value)
        await refused(browser)
      }
    })

    it('is accepted when it is genuine, current and names the sign-in it came from', async () => {
      const { grantId } = sessionIn(await signedIn(A.email))
      const browser = new Browser(h.app)
      browser.cookies.set('pforte_account', await cookieFor(A.email, { grantId }))
      expect((await browser.request('GET', '/account')).body).toContain(A.email)
    })

    it('is not accepted without a sign-in behind it, however genuine it is', async () => {
      for (const overrides of [{}, { grantId: undefined }, { grantId: 42 }]) {
        const browser = new Browser(h.app)
        browser.cookies.set('pforte_account', await cookieFor(B.email, overrides))
        await refused(browser)
      }
    })

    it('is not accepted when it names the sign-in of somebody else', async () => {
      const { grantId: grantOfB } = sessionIn(await signedIn(B.email))
      const browser = new Browser(h.app)
      browser.cookies.set('pforte_account', await cookieFor(A.email, { grantId: grantOfB }))
      await refused(browser)
    })

    it('is not accepted when it names a sign-in of the same person to another application', async () => {
      const web = new Browser(h.app)
      const { code, verifier } = await signIn(web, { ...WEB, email: A.email })
      const tokens = (await web.request('POST', '/token', { form: { grant_type: 'authorization_code', code: code!, redirect_uri: WEB.redirectUri, client_id: WEB.clientId, code_verifier: verifier } })).json()
      const grantOfWeb = (await h.database.pool.query(`select grant_id from oidc_payloads where id = $1 and type = 2`, [tokens.access_token])).rows[0].grant_id as string
      expect(grantOfWeb).toBeTruthy()

      const browser = new Browser(h.app)
      browser.cookies.set('pforte_account', await cookieFor(A.email, { grantId: grantOfWeb }))
      await refused(browser)
    })

    it('stays dead after its sign-in was ended, also when the person signs in again', async () => {
      const first = await signedIn(A.email)
      const stolen = copyOf(first)
      expect((await stolen.request('GET', '/account')).statusCode).toBe(200)

      expect((await h.api('POST', `/users/${await idOf(A.email)}/end-sessions`)).statusCode).toBe(200)
      await refused(copyOf(first))

      // The person signs in anew. That is another sign-in: the old copy is not revived by it.
      const second = await signedIn(A.email)
      expect(sessionIn(second).grantId).not.toBe(sessionIn(first).grantId)
      expect((await second.request('GET', '/account')).statusCode).toBe(200)
      await refused(copyOf(first))
    })

    it('ends with the sign-out of its own browser, while the same person stays signed in elsewhere', async () => {
      const [home, office] = [await signedIn(A.email), await signedIn(A.email)]
      const stolen = copyOf(home)

      const out = await home.request('POST', '/account/logout', { headers: { 'sec-fetch-site': 'same-origin' } })
      const confirm = await home.request('GET', out.headers.location as string)
      const xsrf = /name="xsrf" value="([^"]+)"/.exec(confirm.body)?.[1]
      await home.request('POST', '/session/end/confirm', { form: { xsrf: xsrf!, logout: 'yes' } })

      await refused(stolen)
      expect((await office.request('GET', '/account')).body).toContain(A.email)
    })

    it('ends in every browser when an administrator signs the person out everywhere', async () => {
      const [one, two] = [await signedIn(A.email), await signedIn(A.email)]
      expect((await two.request('GET', '/account')).statusCode).toBe(200)

      expect((await h.api('POST', `/users/${await idOf(A.email)}/end-sessions`)).statusCode).toBe(200)

      await refused(one)
      await refused(two)
    })

    it('ends when the person is locked, also if their sessions were somehow still there', async () => {
      const browser = await signedIn(A.email)
      await h.database.pool.query(`update users set status = 'locked', locked_at = now() where email = $1`, [A.email])
      await refused(browser)
    })

    it('of one person is no use to another: the other stays signed in when the first is signed out', async () => {
      const [browserA, browserB] = [await signedIn(A.email), await signedIn(B.email)]
      await h.api('POST', `/users/${await idOf(A.email)}/end-sessions`)
      await refused(browserA)
      expect((await browserB.request('GET', '/account')).body).toContain(B.email)
    })
  })

  describe('signing out', () => {
    it('clears the session and ends the sign-in of pforte too, so the next person on a shared computer cannot walk in', async () => {
      const browser = await signedIn(A.email)

      const response = await browser.request('POST', '/account/logout', { headers: { 'sec-fetch-site': 'same-origin' } })
      expect(response.statusCode).toBe(303)
      expect(setCookies(response).some((header) => header.startsWith('pforte_account=;'))).toBe(true)
      const target = new URL(response.headers.location as string)
      expect(`${target.origin}${target.pathname}`).toBe(`${ISSUER}/session/end`)
      expect(Object.fromEntries(target.searchParams)).toEqual({ client_id: ACCOUNT_UI_CLIENT_ID, post_logout_redirect_uri: `${ISSUER}/account/signed-out` })

      // pforte asks whether to sign out; the person says yes and lands on the page that says so.
      const confirm = await browser.request('GET', response.headers.location as string)
      expect(confirm.statusCode).toBe(200)
      const xsrf = /name="xsrf" value="([^"]+)"/.exec(confirm.body)?.[1]
      const ended = await browser.request('POST', '/session/end/confirm', { form: { xsrf: xsrf!, logout: 'yes' } })
      const { response: done, visited } = await driveSignIn(h, browser, ended.headers.location as string, A.email)
      expect(visited.at(-1)).toBe('/account/signed-out')
      // In the person's language, which the question left behind: there is no person any more to take one from,
      // and the browser of these tests asks for English.
      expect(done.body).toContain('<html lang="de">')
      expect(done.body).toContain('Sie sind abgemeldet')

      // The next visit needs the password and a code again.
      const before = codesFor(A.email).length
      const again = await driveSignIn(h, browser, '/account', A.email)
      expect(again.response.statusCode).toBe(200)
      expect(codesFor(A.email).length).toBe(before + 1)
    })

    it('shows a page that says so, with a way to sign in again', async () => {
      const response = await new Browser(h.app).request('GET', '/account/signed-out')
      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('You are signed out')
      expect(response.body).toContain('href="/account/login"')
    })

    it('does not happen by opening that page: a link on another site must not end the session', async () => {
      const browser = await signedIn(A.email)
      const page = await browser.request('GET', '/account/signed-out', { headers: { 'sec-fetch-site': 'cross-site' } })
      expect(page.statusCode).toBe(200)
      expect(setCookies(page)).toEqual([])
      expect(browser.cookies.has('pforte_account')).toBe(true)
      expect((await browser.request('GET', '/account')).statusCode).toBe(200)
    })

    it('works without a session too, by going to the page that says you are signed out', async () => {
      const response = await new Browser(h.app).request('POST', '/account/logout')
      expect(response.statusCode).toBe(303)
      expect(response.headers.location).toBe('/account/signed-out')
    })
  })

  describe('other websites', () => {
    it('cannot post a form to the area', async () => {
      const browser = await signedIn(A.email)
      for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { origin: 'https://evil.example' }] as Record<string, string>[]) {
        const response = await browser.request('POST', '/account/logout', { headers })
        expect(response.statusCode).toBe(403)
      }
      expect(browser.cookies.has('pforte_account')).toBe(true)
      expect((await browser.request('GET', '/account')).statusCode).toBe(200)
    })

    it('cannot read the area: no answer carries a CORS header', async () => {
      const browser = await signedIn(A.email)
      const corsHeaders = (response: { headers: Record<string, unknown> }) => Object.keys(response.headers).filter((name) => name.startsWith('access-control-'))
      for (const url of ['/account', '/account/login', '/account/signed-out']) {
        expect(corsHeaders(await browser.request('GET', url, { headers: { origin: 'https://evil.example' } }))).toEqual([])
      }
      const preflight = await h.app.inject({ method: 'OPTIONS', url: '/account', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } })
      expect(corsHeaders(preflight)).toEqual([])
    })
  })

  describe('a callback that does not belong to a sign-in', () => {
    it('is refused without a sign-in in this browser, and when the state does not match', async () => {
      const stranger = await new Browser(h.app).request('GET', '/account/callback?code=x&state=y')
      expect(stranger.statusCode).toBe(400)
      expect(stranger.body).toContain('Signing in did not work')

      const browser = new Browser(h.app)
      await browser.request('GET', '/account/login')
      const mismatch = await browser.request('GET', '/account/callback?code=x&state=not-the-state')
      expect(mismatch.statusCode).toBe(400)
      expect(browser.cookies.has('pforte_account')).toBe(false)
    })
  })

  describe('the token of the account pages', () => {
    it('opens nothing: the admin API does not take it, not even from an administrator', async () => {
      const token = await h.personToken('admin@example.com', { clientId: ACCOUNT_UI_CLIENT_ID, redirectUri: `${ISSUER}/account/callback` })
      for (const url of ['/users', '/whoami', '/clients']) {
        expect((await h.api('GET', url, { token })).statusCode).toBe(401)
      }
    })
  })
})

describe.skipIf(!hasDatabase)('the client of the account pages, where an administrator already used its ID', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  afterAll(async () => {
    await database?.drop()
  })

  it('leaves their client alone, keeps the pages off and says what to do; afterwards the pages come on', async () => {
    await database.pool.query(
      `insert into clients (client_id, name, type, secret_hash, redirect_uris, allowed_grants, scopes) values ($1, 'Customer account portal', 'confidential', 'their-secret-hash', '{https://portal.example.com/cb}', '{authorization_code}', '{openid}')`,
      [ACCOUNT_UI_CLIENT_ID],
    )
    const theirs = async () => (await database.pool.query(`select name, type, secret_hash, redirect_uris, system from clients where client_id = $1`, [ACCOUNT_UI_CLIENT_ID])).rows[0]
    const before = await theirs()

    const blocked = await ensureAccountUiClient(database.db, ISSUER)

    expect(blocked.available).toBe(false)
    expect(blocked).toMatchObject({ reason: expect.stringContaining('pforte-account-ui') })
    expect(blocked).toMatchObject({ reason: expect.stringContaining('DELETE /admin/clients/pforte-account-ui') })
    expect(await theirs()).toEqual(before)
    expect(before).toMatchObject({ name: 'Customer account portal', system: false, redirect_uris: ['https://portal.example.com/cb'] })

    await database.pool.query(`delete from clients where client_id = $1`, [ACCOUNT_UI_CLIENT_ID])
    expect(await ensureAccountUiClient(database.db, ISSUER)).toEqual({ available: true })
    expect(await theirs()).toMatchObject({ name: 'Account', system: true, redirect_uris: [`${ISSUER}/account/callback`] })
  })
})
