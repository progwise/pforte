import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

  const signedIn = async () => {
    const browser = new Browser(h.app)
    await h.database.pool.query('delete from rate_limits')
    const result = await signIn(browser, { ...WEB, email: 'ben.keller@example.com' })
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

    it('speaks the language of the browser', async () => {
      const page = await (await signedIn()).request('GET', '/session/end', { headers: { 'accept-language': 'de-DE,de;q=0.9' } })
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
    const asked = (browser: Browser, language = 'en') =>
      browser.request('GET', `/session/end?${new URLSearchParams({ client_id: WEB.clientId, post_logout_redirect_uri: 'http://localhost:3400/' })}`, {
        headers: { 'accept-language': language },
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
    const signedOutPage = async (language = 'en') => {
      const browser = await signedIn()
      const page = await browser.request('GET', '/session/end')
      const xsrf = /name="xsrf" value="([^"]+)"/.exec(page.body)![1]!
      const done = await browser.request('POST', '/session/end/confirm', { form: { xsrf, logout: 'yes' } })
      expect(done.statusCode).toBe(303)
      return browser.request('GET', done.headers.location as string, { headers: { 'accept-language': language } })
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

    it('speaks the language of the browser', async () => {
      const page = await signedOutPage('fr')
      expect(page.body).toContain('Vous êtes déconnecté')
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
