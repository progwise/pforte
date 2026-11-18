import { hasDatabase } from '@progwise/pforte-db/testing'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { Browser, pkcePair, signIn } from '../test/browser.js'
import { createColorScheme } from './color-scheme.js'
import { createUi } from './index.js'
import { plainTheme, withSignet } from './theme.js'

const DARK_COOKIE = 'pforte_color_scheme=dark; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure'
const LIGHT_COOKIE = 'pforte_color_scheme=light; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure'
const NO_COOKIE = 'pforte_color_scheme=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure'
const PAGE = '<!doctype html>\n<html lang="de">\n<head>'

describe('light or dark, as a request says', () => {
  const colorScheme = createColorScheme({ secure: true })
  const { mark } = colorScheme
  const A_PAGE = { status: 200, contentType: 'text/html; charset=utf-8' }
  /** What a request says, where the answer to it is a page unless the test says otherwise. */
  const of = (method: string, parameter: unknown, cookieHeader: string | undefined, answer: { status: number; contentType: unknown } = A_PAGE, from = colorScheme) => from.of({ method, parameter, cookieHeader }, answer)

  it('takes the parameter and answers with a cookie that holds for 400 days', () => {
    expect(of('GET', 'dark', undefined)).toEqual({ scheme: 'dark', setCookie: DARK_COOKIE })
    expect(of('GET', 'light', undefined)).toEqual({ scheme: 'light', setCookie: LIGHT_COOKIE })
    expect(of('GET', 'dark', undefined, A_PAGE, createColorScheme({ secure: false })).setCookie).toBe(DARK_COOKIE.replace('; Secure', ''))
  })

  it('takes the cookie where the request has no parameter, and sets none', () => {
    expect(of('GET', undefined, 'a=b; pforte_color_scheme=dark; c=d')).toEqual({ scheme: 'dark' })
    expect(of('POST', undefined, 'pforte_color_scheme=light')).toEqual({ scheme: 'light' })
  })

  it('lets the parameter win over the cookie: the application that asks last decides', () => {
    expect(of('GET', 'light', 'pforte_color_scheme=dark')).toEqual({ scheme: 'light', setCookie: LIGHT_COOKIE })
  })

  it('removes the cookie with auto, and says nothing about the page: the device decides again', () => {
    expect(of('GET', 'auto', 'pforte_color_scheme=dark')).toEqual({ setCookie: NO_COOKIE })
  })

  it('says nothing without parameter and cookie', () => {
    expect(of('GET', undefined, undefined)).toEqual({})
    expect(of('GET', undefined, 'other=dark')).toEqual({})
  })

  it.each(['Dark', 'DARK', 'black', '', 'dark"><script>', ['dark', 'light'], { a: 'dark' }, 1])('ignores a parameter that is none of the three words: %j', (parameter) => {
    expect(of('GET', parameter, undefined)).toEqual({})
    expect(of('GET', parameter, 'pforte_color_scheme=dark')).toEqual({ scheme: 'dark' })
  })

  it.each(['night', 'dark"><script>', 'DARK', ''])('ignores a cookie that is neither of the two words: %j', (value) => {
    expect(of('GET', undefined, `pforte_color_scheme=${value}`)).toEqual({})
  })

  it('takes the parameter from a request for a page only: a form that is sent changes nothing', () => {
    expect(of('POST', 'dark', undefined)).toEqual({})
    expect(of('POST', 'light', 'pforte_color_scheme=dark')).toEqual({ scheme: 'dark' })
  })

  it.each([
    ['a redirect on the way to a page', { status: 303, contentType: undefined }],
    ['a redirect with 302', { status: 302, contentType: undefined }],
    ['a redirect with 307', { status: 307, contentType: undefined }],
    ['a page that says what went wrong', { status: 400, contentType: 'text/html; charset=utf-8' }],
  ])('sets the cookie with %s', (_name, answer) => {
    expect(of('GET', 'dark', undefined, answer)).toEqual({ scheme: 'dark', setCookie: DARK_COOKIE })
    expect(of('GET', 'auto', 'pforte_color_scheme=dark', answer)).toEqual({ setCookie: NO_COOKIE })
  })

  it.each([
    ['a file of the branding folder, which a cache may keep and hand to others', { status: 200, contentType: 'image/svg+xml' }],
    ['a font', { status: 200, contentType: 'font/woff2' }],
    ['data', { status: 200, contentType: 'application/json; charset=utf-8' }],
    ['a script', { status: 200, contentType: 'text/javascript' }],
    ['an answer without content', { status: 204, contentType: undefined }],
    ['a redirect that a browser keeps for good', { status: 301, contentType: undefined }],
    ['a redirect that a browser keeps for good, with 308', { status: 308, contentType: undefined }],
  ])('sets no cookie with %s, and still reads the one that is there', (_name, answer) => {
    expect(of('GET', 'dark', undefined, answer)).toEqual({})
    expect(of('GET', 'light', 'pforte_color_scheme=dark', answer)).toEqual({ scheme: 'dark' })
    expect(of('GET', 'auto', 'pforte_color_scheme=dark', answer)).toEqual({ scheme: 'dark' })
  })

  it('writes the look on a page of pforte, and leaves everything else alone', () => {
    expect(mark(PAGE, 'dark')).toBe('<!doctype html>\n<html lang="de" data-color-scheme="dark">\n<head>')
    expect(mark(PAGE, 'light')).toBe('<!doctype html>\n<html lang="de" data-color-scheme="light">\n<head>')
    expect(mark(PAGE, undefined)).toBe(PAGE)
    expect(mark('{"html":"<html lang=\\"de\\">"}', 'dark')).toBe('{"html":"<html lang=\\"de\\">"}')
    expect(mark(`<p>${PAGE}</p>`, 'dark')).toBe(`<p>${PAGE}</p>`)
    const bytes = Buffer.from(PAGE)
    expect(mark(bytes, 'dark')).toBe(bytes)
    expect(mark(undefined, 'dark')).toBeUndefined()
  })
})

describe('an installation that is light for everybody ("dark": false)', () => {
  it('takes no parameter, sets no cookie and marks no page', async () => {
    const ui = createUi({ theme: withSignet(plainTheme()) })
    const app = buildApp({ getDatabaseTime: async () => new Date(), ui, issuer: 'https://id.example.com' })
    app.get('/page', (_request, reply) => reply.type('text/html').send(ui.pages.for('de').notice('Titel', 'Text')))
    const response = await app.inject({ url: '/page?color_scheme=dark', headers: { cookie: 'pforte_color_scheme=dark' } })
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.body).toContain('<html lang="de">')
    expect(response.body).not.toContain('color-scheme')
  })
})

describe('a page that Fastify sends', () => {
  const ui = createUi()
  const app = Fastify()
  createColorScheme({ secure: true }).addTo(app)
  app.get('/page', (_request, reply) => reply.type('text/html').send(ui.pages.for('de').notice('Titel', 'Text')))
  app.get('/data', () => ({ page: PAGE }))
  app.get('/away', (_request, reply) => reply.header('Set-Cookie', 'other=1; Path=/').redirect('/page', 303))

  it('is marked and counted anew, so the browser gets all of it', async () => {
    const response = await app.inject({ url: '/page?color_scheme=dark' })
    expect(response.headers['set-cookie']).toBe(DARK_COOKIE)
    expect(response.body).toContain('<html lang="de" data-color-scheme="dark">')
    expect(response.body.endsWith('</html>')).toBe(true)
    expect(Number(response.headers['content-length'])).toBe(Buffer.byteLength(response.body))
  })

  it('keeps the cookies the page sets itself, also on a redirect', async () => {
    const response = await app.inject({ url: '/away?color_scheme=light' })
    expect(response.statusCode).toBe(303)
    expect(response.headers['set-cookie']).toEqual(['other=1; Path=/', LIGHT_COOKIE])
  })

  it('leaves data alone, and sets no cookie with it', async () => {
    const response = await app.inject({ url: '/data?color_scheme=light', headers: { cookie: 'pforte_color_scheme=dark' } })
    expect(response.json()).toEqual({ page: PAGE })
    expect(response.headers['set-cookie']).toBeUndefined()
  })
})

describe.skipIf(!hasDatabase)('light or dark across the pages of pforte', () => {
  let h: AdminHarness
  const WEB = { clientId: 'demo-web', redirectUri: 'http://localhost:3400/callback' }
  const EMAIL = 'ben.keller@example.com'

  beforeAll(async () => {
    h = await createAdminHarness()
  })

  afterAll(async () => {
    await h?.close()
  })

  const schemeCookies = (response: { headers: Record<string, unknown> }) =>
    [response.headers['set-cookie'] ?? []].flat().map(String).filter((header) => header.startsWith('pforte_color_scheme='))
  const lookOf = (body: string) => /^<!doctype html>\n<html lang="[a-z-]+"(?: data-color-scheme="(\w+)")?>/.exec(body)?.[1] ?? 'the device decides'
  /** An authorization request as an application sends it, with what it says about its look. */
  const authorize = (browser: Browser, colorScheme?: string) => {
    const query = new URLSearchParams({
      client_id: WEB.clientId,
      redirect_uri: WEB.redirectUri,
      response_type: 'code',
      scope: 'openid',
      state: 's',
      nonce: 'n',
      code_challenge: pkcePair().challenge,
      code_challenge_method: 'S256',
      ...(colorScheme ? { color_scheme: colorScheme } : {}),
    })
    return browser.request('GET', `/auth?${query}`)
  }

  it('says nothing where no application said anything: the stylesheet follows the device', async () => {
    const browser = new Browser(h.app)
    const authorized = await authorize(browser)
    expect(schemeCookies(authorized)).toEqual([])
    const page = await browser.request('GET', authorized.headers.location as string)
    expect(lookOf(page.body)).toBe('the device decides')
    expect(page.body).toContain('@media (prefers-color-scheme: dark) {\n:root:not([data-color-scheme="light"]) {')
    expect(schemeCookies(page)).toEqual([])
  })

  it('is dark from the authorization request on, on every page of the sign-in, without the parameter being passed on', async () => {
    const browser = new Browser(h.app)
    const authorized = await authorize(browser, 'dark')
    expect(authorized.statusCode).toBe(303)
    expect(schemeCookies(authorized)).toEqual([DARK_COOKIE])
    const interaction = authorized.headers.location as string
    expect(interaction).not.toContain('color_scheme')

    const login = await browser.request('GET', interaction)
    expect(lookOf(login.body)).toBe('dark')
    expect(schemeCookies(login)).toEqual([])
    // A page that answers a form: the wrong password, then the code.
    const wrong = await browser.request('POST', `${interaction}/login`, { form: { email: EMAIL, password: 'wrong-password' } })
    expect(lookOf(wrong.body)).toBe('dark')
    await h.database.pool.query('delete from rate_limits')
    const right = await browser.request('POST', `${interaction}/login`, { form: { email: EMAIL, password: 'dev-password' } })
    expect(lookOf((await browser.request('GET', right.headers.location as string)).body)).toBe('dark')
  })

  it('stays dark for whatever comes later in that browser: the reset, the account pages, the administration, the sign-out', async () => {
    const browser = new Browser(h.app)
    await authorize(browser, 'dark')
    expect(lookOf((await browser.request('GET', '/reset')).body)).toBe('dark')
    expect(lookOf((await browser.request('GET', '/account/signed-out')).body)).toBe('dark')
    expect(lookOf((await browser.request('GET', '/manage/signed-out')).body)).toBe('dark')
    // The pages the OpenID library sends: the notice after a sign-out, and an error.
    expect(lookOf((await browser.request('GET', '/session/end/success')).body)).toBe('dark')
    const refused = await browser.request('GET', '/auth?client_id=nobody&response_type=code')
    expect(refused.statusCode).toBe(400)
    expect(lookOf(refused.body)).toBe('dark')
  })

  it('changes when an application says something else, and not when one says nothing', async () => {
    const browser = new Browser(h.app)
    await authorize(browser, 'dark')
    const silent = await authorize(browser)
    expect(schemeCookies(silent)).toEqual([])
    expect(lookOf((await browser.request('GET', silent.headers.location as string)).body)).toBe('dark')

    const light = await authorize(browser, 'light')
    expect(schemeCookies(light)).toEqual([LIGHT_COOKIE])
    expect(lookOf((await browser.request('GET', light.headers.location as string)).body)).toBe('light')

    const auto = await authorize(browser, 'auto')
    expect(schemeCookies(auto)).toEqual([NO_COOKIE])
    expect(lookOf((await browser.request('GET', auto.headers.location as string)).body)).toBe('the device decides')
  })

  it('takes the parameter with the end-session request: the question and the notice after it are dark', async () => {
    const browser = new Browser(h.app)
    await h.database.pool.query('delete from rate_limits')
    expect((await signIn(browser, { ...WEB, email: EMAIL })).code).toBeTruthy()

    const question = await browser.request('GET', '/session/end?color_scheme=dark')
    expect(schemeCookies(question)).toEqual([DARK_COOKIE])
    expect(lookOf(question.body)).toBe('dark')
    // The cookie of the language of the sign-out is still set with it.
    expect([question.headers['set-cookie']].flat().map(String).some((header) => header.startsWith('pforte_logout_language='))).toBe(true)

    const xsrf = /name="xsrf" value="([^"]+)"/.exec(question.body)![1]!
    const answered = await browser.request('POST', '/session/end/confirm', { form: { xsrf, logout: 'yes' } })
    expect(lookOf((await browser.request('GET', answered.headers.location as string)).body)).toBe('dark')
  })

  it('takes the parameter on a link to the account pages, and keeps it through the sign-in that follows', async () => {
    const browser = new Browser(h.app)
    const start = await browser.request('GET', '/account?color_scheme=dark')
    expect(start.statusCode).toBe(303)
    expect(schemeCookies(start)).toEqual([DARK_COOKIE])
    expect(lookOf((await browser.request('GET', '/account/signed-out')).body)).toBe('dark')
  })

  it('sets no cookie with a file that a cache may keep for others, nor with the answers of the interfaces for programs', async () => {
    const browser = new Browser(h.app)
    const signet = await browser.request('GET', `${createUi().theme.iconUrl}?color_scheme=dark`)
    expect(signet.statusCode).toBe(200)
    expect(signet.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(signet.headers['set-cookie']).toBeUndefined()

    for (const url of ['/.well-known/openid-configuration?color_scheme=dark', '/jwks?color_scheme=dark', '/health?color_scheme=dark']) {
      const response = await browser.request('GET', url)
      expect(response.statusCode, url).toBe(200)
      expect(schemeCookies(response), url).toEqual([])
    }
    const users = await h.api('GET', '/users?color_scheme=dark')
    expect(users.statusCode).toBe(200)
    expect(schemeCookies(users)).toEqual([])
    expect(browser.cookies.has('pforte_color_scheme')).toBe(false)
  })

  it('never marks what the interfaces for programs answer', async () => {
    const browser = new Browser(h.app)
    browser.cookies.set('pforte_color_scheme', 'dark')
    expect((await browser.request('GET', '/.well-known/openid-configuration')).json().issuer).toBe('https://localhost:3300')
    const users = await h.api('GET', '/users')
    expect(users.statusCode).toBe(200)
    expect(users.body).not.toContain('data-color-scheme')
  })
})
