import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { Browser, signIn } from '../test/browser.js'

const WEB = { clientId: 'demo-web', redirectUri: 'http://localhost:3400/callback' }

/** Any address a page would send the visitor's browser to, other than this server: fonts, scripts, images. */
const externalAddresses = (html: string) => [...html.matchAll(/(?:src|href|url\(|@import)\s*[="'(]*\s*(https?:)?\/\/(?!localhost)[^\s"')]+/g)].map((match) => match[0])

describe.skipIf(!hasDatabase)('the pages of the OpenID library, in pforte\'s look', () => {
  let h: AdminHarness

  beforeAll(async () => {
    h = await createAdminHarness()
  })

  afterAll(async () => {
    await h?.close()
  })

  const PERSON = 'ben.keller@example.com'
  /** The language stored for the person who signs out in these tests; English unless a test says otherwise. */
  const speaks = (language: string) => h.database.pool.query('update users set language = $1 where email = $2', [language, PERSON])

  afterEach(async () => {
    await speaks('en')
  })

  const signedIn = async () => {
    const browser = new Browser(h.app)
    await h.database.pool.query('delete from rate_limits')
    const result = await signIn(browser, { ...WEB, email: PERSON })
    expect(result.code).toBeTruthy()
    return browser
  }

  describe('asking whether to sign out', () => {
    it('is a card in the look of the installation, with the question and both answers', async () => {
      const browser = await signedIn()
      const page = await browser.request('GET', '/session/end', { headers: { 'accept-language': 'en' } })

      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('<html lang="en">')
      expect(page.body).toContain('<h1>Sign out?</h1>')
      expect(page.body).toContain('Do you want to sign out of localhost:3300?')
      expect(page.body).toContain('Yes, sign me out')
      expect(page.body).toContain('No, stay signed in')
      // the form the library made, with its protection against forgery, which the buttons belong to
      expect(page.body).toMatch(/<form id="op\.logoutForm" method="post" action="[^"]*\/session\/end\/confirm"><input type="hidden" name="xsrf" value="[^"]+"\/><\/form>/)
      expect(page.body).toContain('form="op.logoutForm"')
      expect(page.body).toContain('--primary:')
    })

    it('asks nothing of other sites and runs no script, and has the policy of pforte\'s pages', async () => {
      const page = await (await signedIn()).request('GET', '/session/end')
      expect(externalAddresses(page.body)).toEqual([])
      expect(page.body).not.toContain('googleapis')
      expect(page.body).not.toContain('<script')
      expect(page.headers['content-security-policy']).toContain("default-src 'none'")
      expect(page.headers['content-security-policy']).not.toContain('script-src')
      expect(page.headers['x-frame-options']).toBe('DENY')
    })

    it('speaks the language of the person who is signed in, whatever the browser says', async () => {
      await speaks('de')
      const page = await (await signedIn()).request('GET', '/session/end', { headers: { 'accept-language': 'en-US,en;q=0.9' } })
      expect(page.body).toContain('<html lang="de">')
      expect(page.body).toContain('Möchten Sie sich von localhost:3300 abmelden?')
      expect(page.body).toContain('Ja, abmelden')
    })

    it('still ends the session when confirmed, and keeps it when not', async () => {
      const browser = await signedIn()
      const page = await browser.request('GET', '/session/end')
      const xsrf = /name="xsrf" value="([^"]+)"/.exec(page.body)![1]!

      const kept = await browser.request('POST', '/session/end/confirm', { form: { xsrf } })
      expect(kept.statusCode).toBe(303)

      const page2 = await browser.request('GET', '/session/end')
      const xsrf2 = /name="xsrf" value="([^"]+)"/.exec(page2.body)![1]!
      const done = await browser.request('POST', '/session/end/confirm', { form: { xsrf: xsrf2, logout: 'yes' } })
      expect(done.statusCode).toBe(303)
    })
  })

  // An application ends its own session before it sends the browser here, and its tokens are revoked whatever the
  // answer is. So the question is not whether to sign out, but whether to end the sign-in at pforte as well.
  describe('asking on behalf of an application', () => {
    const NAME = 'Demo web app (public client)'
    /** The application asks, and says in which language (`ui_locales`), as it does when it sends somebody to sign in. */
    const asked = (browser: Browser, language = 'en') =>
      browser.request('GET', `/session/end?${new URLSearchParams({ client_id: WEB.clientId, post_logout_redirect_uri: 'http://localhost:3400/', ui_locales: language })}`, {
        headers: { 'accept-language': 'en' },
      })
    const xsrfOf = (body: string) => /name="xsrf" value="([^"]+)"/.exec(body)![1]!
    /** Where pforte sends a browser that asks to sign in to the application: to its sign-in page, or straight back. */
    const signInAgain = async (browser: Browser) => {
      const query = new URLSearchParams({
        client_id: WEB.clientId,
        redirect_uri: WEB.redirectUri,
        response_type: 'code',
        scope: 'openid',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
      })
      return (await browser.request('GET', `/auth?${query}`)).headers.location as string
    }

    it('says that the application is left either way, and asks about the sign-in at pforte', async () => {
      const page = await asked(await signedIn())

      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('<h1>Sign out completely?</h1>')
      expect(page.body).toContain(`You are leaving ${NAME}.`)
      expect(page.body).toContain('still signed in at localhost:3300')
      // no word about a password: a fresh sign-in may be a passkey, and an application can ask for one after a no too
      expect(page.body).toContain(`can open ${NAME} again without a new sign-in`)
      expect(page.body).not.toContain('password')
      expect(page.body).toContain('Yes, sign me out')
      expect(page.body).toContain(`No, only leave ${NAME}`)
      // nothing promises that the application stays signed in: it does not
      expect(page.body).not.toContain('stay signed in')
    })

    it.each([
      ['de', 'Vollständig abmelden?', `Nein, nur ${NAME} verlassen`],
      ['fr', 'Se déconnecter complètement ?', `Non, quitter seulement ${NAME}`],
      ['hu', 'Teljesen kijelentkezik?', `Nem, csak innen lépek ki: ${NAME}`],
    ])('asks the same in %s', async (language, title, no) => {
      const page = await asked(await signedIn(), language)
      expect(page.body).toContain(`<h1>${title}</h1>`)
      expect(page.body).toContain(no)
    })

    it('goes back to the application after a no, with the sign-in at pforte kept', async () => {
      const browser = await signedIn()
      const answered = await browser.request('POST', '/session/end/confirm', { form: { xsrf: xsrfOf((await asked(browser)).body) } })

      expect(answered.statusCode).toBe(303)
      expect(answered.headers.location).toBe('http://localhost:3400/')
      expect(await signInAgain(browser)).toMatch(/^http:\/\/localhost:3400\/callback\?code=/)
    })

    it('goes back to the application after a yes, with the sign-in at pforte ended', async () => {
      const browser = await signedIn()
      const answered = await browser.request('POST', '/session/end/confirm', { form: { xsrf: xsrfOf((await asked(browser)).body), logout: 'yes' } })

      expect(answered.headers.location).toBe('http://localhost:3400/')
      expect(await signInAgain(browser)).toMatch(/\/interaction\//)
    })
  })

  describe('after a no', () => {
    const answeredNo = async (query = '') => {
      const browser = await signedIn()
      const page = await browser.request('GET', `/session/end${query}`)
      const xsrf = /name="xsrf" value="([^"]+)"/.exec(page.body)![1]!
      const kept = await browser.request('POST', '/session/end/confirm', { form: { xsrf } })
      expect(kept.statusCode).toBe(303)
      return browser.request('GET', kept.headers.location as string, { headers: { 'accept-language': 'en' } })
    }

    it('does not claim that the person is signed out', async () => {
      const page = await answeredNo()
      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('<h1>You are still signed in</h1>')
      expect(page.body).toContain('This browser stays signed in at localhost:3300.')
      expect(page.body).not.toContain('You are signed out')
      expect(page.headers['content-security-policy']).toContain("default-src 'none'")
    })

    it('says the same when an application asked that names no address to return to', async () => {
      const page = await answeredNo(`?client_id=${WEB.clientId}`)
      expect(page.body).toContain('<h1>You are still signed in</h1>')
      expect(page.body).not.toContain('You are signed out')
    })
  })

  describe('after signing out', () => {
    const signedOutPage = async () => {
      const browser = await signedIn()
      const page = await browser.request('GET', '/session/end')
      const xsrf = /name="xsrf" value="([^"]+)"/.exec(page.body)![1]!
      const done = await browser.request('POST', '/session/end/confirm', { form: { xsrf, logout: 'yes' } })
      expect(done.statusCode).toBe(303)
      return browser.request('GET', done.headers.location as string, { headers: { 'accept-language': 'en' } })
    }

    it('says so on a card, with nothing from other sites', async () => {
      const page = await signedOutPage()
      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('<h1>You are signed out</h1>')
      expect(page.body).toContain('Your sign-out was successful.')
      expect(externalAddresses(page.body)).toEqual([])
      expect(page.body).not.toContain('googleapis')
      expect(page.headers['content-security-policy']).toContain("default-src 'none'")
    })

    it('speaks the language of the browser to somebody who comes here without a sign-out behind them', async () => {
      const page = await new Browser(h.app).request('GET', '/session/end/success', { headers: { 'accept-language': 'fr' } })
      expect(page.body).toContain('Vous êtes déconnecté')
      expect(page.headers['set-cookie']).toBeUndefined()
    })
  })

  // As the pages of a sign-in: what the application asked for, else the person's own language, else the browser's.
  describe('the language of a sign-out', () => {
    const ENGLISH_BROWSER = { headers: { 'accept-language': 'en-US,en;q=0.9' } }
    const xsrfOf = (body: string) => /name="xsrf" value="([^"]+)"/.exec(body)![1]!
    const languageCookies = (response: { headers: Record<string, unknown> }) =>
      [response.headers['set-cookie'] ?? []].flat().map(String).filter((header) => header.startsWith('pforte_logout_language='))
    /** Asks to sign out, answers, and opens the page the answer leads to: the question and the notice. */
    const signOut = async (browser: Browser, query: Record<string, string> = {}, answer: 'yes' | 'no' = 'yes') => {
      const question = await browser.request('GET', `/session/end?${new URLSearchParams(query)}`, ENGLISH_BROWSER)
      const answered = await browser.request('POST', '/session/end/confirm', { form: { xsrf: xsrfOf(question.body), ...(answer === 'yes' ? { logout: 'yes' } : {}) }, ...ENGLISH_BROWSER })
      expect(answered.statusCode).toBe(303)
      const notice = await browser.request('GET', answered.headers.location as string, ENGLISH_BROWSER)
      return { question, notice }
    }
    /** An ID token of the person, as an application holds it and sends it along as `id_token_hint`. */
    const idToken = async () => {
      const browser = new Browser(h.app)
      await h.database.pool.query('delete from rate_limits')
      const { code, verifier } = await signIn(browser, { ...WEB, email: PERSON })
      const tokens = (await browser.request('POST', '/token', { form: { client_id: WEB.clientId, grant_type: 'authorization_code', code: code!, redirect_uri: WEB.redirectUri, code_verifier: verifier } })).json()
      return tokens.id_token as string
    }

    it('is the one the application asks for with ui_locales, for the question and for the notice after it', async () => {
      const { question, notice } = await signOut(await signedIn(), { ui_locales: 'de' })
      expect(question.body).toContain('<html lang="de">')
      expect(question.body).toContain('Ja, abmelden')
      expect(notice.body).toContain('<html lang="de">')
      expect(notice.body).toContain('<h1>Sie sind abgemeldet</h1>')
    })

    it('stays the same after a no', async () => {
      const { notice } = await signOut(await signedIn(), { ui_locales: 'de' }, 'no')
      expect(notice.body).toContain('<h1>Sie sind weiterhin angemeldet</h1>')
    })

    it('is the person\'s own without ui_locales', async () => {
      await speaks('fr')
      const { question, notice } = await signOut(await signedIn())
      expect(question.body).toContain('<html lang="fr">')
      expect(notice.body).toContain('<h1>Vous êtes déconnecté</h1>')
    })

    it('takes the first language of ui_locales that pforte speaks, and falls through to the person\'s where it speaks none', async () => {
      await speaks('hu')
      const browser = await signedIn()
      expect((await browser.request('GET', '/session/end?ui_locales=pt+de+fr', ENGLISH_BROWSER)).body).toContain('<html lang="de">')
      expect((await browser.request('GET', '/session/end?ui_locales=fr-CH', ENGLISH_BROWSER)).body).toContain('<html lang="fr">')
      expect((await browser.request('GET', '/session/end?ui_locales=pt+xx', ENGLISH_BROWSER)).body).toContain('<html lang="hu">')
    })

    it('is the one of the person an id_token_hint names, in a browser that has no session any more', async () => {
      const hint = await idToken()
      await speaks('hu')
      // Without a session the library asks nothing: its page sends the answer by itself, as a browser would.
      const { question, notice } = await signOut(new Browser(h.app), { id_token_hint: hint })
      expect(question.body).not.toContain('<h1>')
      expect(notice.body).toContain('<h1>Ki van jelentkezve</h1>')
    })

    it('is the browser\'s without a session and without a hint', async () => {
      const browser = new Browser(h.app)
      const question = await browser.request('GET', '/session/end', { headers: { 'accept-language': 'fr-FR,fr;q=0.9,en;q=0.5' } })
      const answered = await browser.request('POST', '/session/end/confirm', { form: { xsrf: xsrfOf(question.body), logout: 'yes' } })
      const notice = await browser.request('GET', answered.headers.location as string, { headers: { 'accept-language': 'fr-FR,fr;q=0.9,en;q=0.5' } })
      expect(notice.body).toContain('<h1>Vous êtes déconnecté</h1>')
    })

    it('travels in a cookie that the request sets and the notice removes', async () => {
      const { question, notice } = await signOut(await signedIn(), { ui_locales: 'de' })
      expect(languageCookies(question)).toEqual([expect.stringMatching(/^pforte_logout_language=[\w-]+\.[\w-]+; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/)])
      expect(languageCookies(notice)).toEqual(['pforte_logout_language=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure'])
    })

    it.each(['yes', 'no'] as const)('ends with the answer "%s" where that leads back to an application, so no later page of pforte speaks it', async (answer) => {
      const browser = await signedIn()
      const query = new URLSearchParams({ client_id: WEB.clientId, post_logout_redirect_uri: 'http://localhost:3400/', ui_locales: 'de' })
      const question = await browser.request('GET', `/session/end?${query}`, ENGLISH_BROWSER)
      expect(question.body).toContain('<html lang="de">')

      const answered = await browser.request('POST', '/session/end/confirm', { form: { xsrf: xsrfOf(question.body), ...(answer === 'yes' ? { logout: 'yes' } : {}) } })
      expect(answered.headers.location).toBe('http://localhost:3400/')
      expect(languageCookies(answered)).toEqual(['pforte_logout_language=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure'])

      // Somebody opens a notice of pforte a moment later, in a browser that prefers French.
      const french = { headers: { 'accept-language': 'fr-FR,fr;q=0.9' } }
      expect((await browser.request('GET', '/session/end/success', french)).body).toContain('<html lang="fr">')
      expect((await browser.request('GET', '/account/signed-out', french)).body).toContain('<html lang="fr">')
      // The administration has English and German only: French is not German.
      expect((await browser.request('GET', '/manage/signed-out', french)).body).not.toContain('<html lang="de">')
    })

    it('ends with the answer also where the application lives at pforte\'s own host, under another path', async () => {
      const own = 'https://localhost:3300/shop/signed-out'
      expect((await h.api('PATCH', '/clients/demo-web', { body: { postLogoutRedirectUris: ['http://localhost:3400/', own] } })).statusCode).toBe(200)
      const browser = await signedIn()
      const query = new URLSearchParams({ client_id: WEB.clientId, post_logout_redirect_uri: own, state: 'abc', ui_locales: 'de' })
      const question = await browser.request('GET', `/session/end?${query}`, ENGLISH_BROWSER)

      const answered = await browser.request('POST', '/session/end/confirm', { form: { xsrf: xsrfOf(question.body), logout: 'yes' } })
      expect(answered.headers.location).toBe(`${own}?state=abc`)
      expect(languageCookies(answered)).toEqual(['pforte_logout_language=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure'])
      const french = { headers: { 'accept-language': 'fr-FR,fr;q=0.9' } }
      expect((await browser.request('GET', '/session/end/success', french)).body).toContain('<html lang="fr">')
    })

    it.each([
      ['the provider\'s notice', {}, 'https://localhost:3300/session/end/success'],
      ['the provider\'s notice for an application', { client_id: WEB.clientId }, 'https://localhost:3300/session/end/success'],
      ['the "signed out" page of the account pages', { client_id: 'pforte-account-ui', post_logout_redirect_uri: 'https://localhost:3300/account/signed-out', state: 'abc' }, 'https://localhost:3300/account/signed-out?state=abc'],
      ['the "signed out" page of the administration', { client_id: 'pforte-admin-ui', post_logout_redirect_uri: 'https://localhost:3300/manage/signed-out' }, 'https://localhost:3300/manage/signed-out'],
    ])('keeps it with the answer where the page that follows is %s', async (_page, parameters, location) => {
      const browser = await signedIn()
      const question = await browser.request('GET', `/session/end?${new URLSearchParams({ ...parameters, ui_locales: 'de' })}`, ENGLISH_BROWSER)
      const answered = await browser.request('POST', '/session/end/confirm', { form: { xsrf: xsrfOf(question.body), logout: 'yes' } })
      expect(answered.headers.location).toBe(location)
      expect(languageCookies(answered)).toEqual([])
      expect((await browser.request('GET', location, ENGLISH_BROWSER)).body).toContain('<html lang="de">')
    })

    it('keeps it after a no for an application that names no address to return to', async () => {
      const browser = await signedIn()
      const question = await browser.request('GET', `/session/end?${new URLSearchParams({ client_id: WEB.clientId, ui_locales: 'de' })}`, ENGLISH_BROWSER)
      const answered = await browser.request('POST', '/session/end/confirm', { form: { xsrf: xsrfOf(question.body) } })
      expect(answered.headers.location).toBe(`https://localhost:3300/session/end/success?client_id=${WEB.clientId}`)
      expect(languageCookies(answered)).toEqual([])
    })

    it('takes no language from a cookie it did not sign', async () => {
      const browser = new Browser(h.app)
      browser.cookies.set('pforte_logout_language', Buffer.from(JSON.stringify({ language: 'de', expiresAt: Date.now() + 60_000 })).toString('base64url') + '.forged')
      const page = await browser.request('GET', '/session/end/success', ENGLISH_BROWSER)
      expect(page.body).toContain('<h1>You are signed out</h1>')
    })

    it('leaves no language behind where the request to sign out is refused', async () => {
      const refused = await (await signedIn()).request('GET', '/session/end?id_token_hint=not-a-token&ui_locales=de', ENGLISH_BROWSER)
      expect(refused.statusCode).toBe(400)
      expect(languageCookies(refused)).toEqual([])
    })
  })

  it('shows errors of the provider in the same look, with the same policy', async () => {
    const page = await new Browser(h.app).request('GET', '/auth?client_id=nobody&response_type=code', { headers: { 'accept-language': 'en' } })
    expect(page.body).toContain('Something went wrong')
    expect(externalAddresses(page.body)).toEqual([])
    expect(page.headers['content-security-policy']).toContain("default-src 'none'")
  })

  it('has nothing in its own pages that calls out to another site, whatever the theme', () => {
    expect(externalAddresses('<style>@import url(https://fonts.googleapis.com/css?family=Roboto);</style>').length).toBeGreaterThan(0)
    expect(externalAddresses('<a href="https://example.com/imprint">x</a>').length).toBeGreaterThan(0)
    expect(externalAddresses('<a href="/reset">x</a><form action="http://localhost:3300/x">')).toEqual([])
  })
})
