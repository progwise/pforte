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
