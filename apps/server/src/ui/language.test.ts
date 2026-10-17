import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { Browser, pkcePair } from '../test/browser.js'

const WEB = { clientId: 'demo-web', redirectUri: 'http://localhost:3400/callback' }

describe.skipIf(!hasDatabase)('the language of the pages', () => {
  let h: AdminHarness
  let counter = 0

  beforeAll(async () => {
    h = await createAdminHarness()
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(async () => {
    h.notifications.length = 0
    await h.database.pool.query(`delete from otp_codes`)
    await h.database.pool.query(`update users set status = 'active' where password_hash is not null`)
  })

  const startSignIn = async (params: Record<string, string> = {}, headers: Record<string, string> = {}) => {
    const browser = new Browser(h.app)
    const query = new URLSearchParams({
      client_id: WEB.clientId,
      redirect_uri: WEB.redirectUri,
      response_type: 'code',
      scope: 'openid',
      state: 's',
      nonce: 'n',
      code_challenge: pkcePair().challenge,
      code_challenge_method: 'S256',
      ...params,
    })
    const authorize = await browser.request('GET', `/auth?${query}`, { headers })
    const interaction = authorize.headers.location as string
    const page = await browser.request('GET', interaction, { headers })
    return { browser, interaction, page }
  }
  const password = (s: Awaited<ReturnType<typeof startSignIn>>, email: string, headers: Record<string, string> = {}, secret = 'dev-password') =>
    s.browser.request('POST', `${s.interaction}/login`, { form: { email, password: secret }, headers })

  describe('sign-in', () => {
    it('follows ui_locales, the way the application asks for it', async () => {
      const french = await startSignIn({ ui_locales: 'fr' })
      expect(french.page.body).toContain('<html lang="fr">')
      expect(french.page.body).toContain('Mot de passe oublié ?')

      expect((await startSignIn({ ui_locales: 'xx hu de' })).page.body).toContain('<html lang="hu">')
      expect((await startSignIn({ ui_locales: 'de-AT' })).page.body).toContain('<html lang="de">')
    })

    it('falls back to the browser\'s language, and then to English', async () => {
      expect((await startSignIn({}, { 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' })).page.body).toContain('<html lang="de">')
      expect((await startSignIn({ ui_locales: 'xx' }, { 'accept-language': 'hu' })).page.body).toContain('<html lang="hu">')
      expect((await startSignIn({}, { 'accept-language': 'zz' })).page.body).toContain('<html lang="en">')
      expect((await startSignIn()).page.body).toContain('<html lang="en">')
    })

    it('puts what the application asked for before the browser', async () => {
      expect((await startSignIn({ ui_locales: 'fr' }, { 'accept-language': 'de' })).page.body).toContain('<html lang="fr">')
    })

    it('says "wrong password" in the same language', async () => {
      const s = await startSignIn({ ui_locales: 'fr' })
      const wrong = await password(s, 'anna.schmidt@example.com', {}, 'nope')
      expect(wrong.statusCode).toBe(401)
      expect(wrong.body).toContain('<html lang="fr">')
      expect(wrong.body).toContain('est pas correct')
    })

    it('goes on in the language of the user once the password is right, unless the application asked otherwise', async () => {
      // the seeded users have German as their language
      const own = await startSignIn({}, { 'accept-language': 'en' })
      const step = await password(own, 'anna.schmidt@example.com')
      expect((await own.browser.request('GET', step.headers.location as string)).body).toContain('<html lang="de">')

      await h.database.pool.query(`delete from otp_codes`)
      const asked = await startSignIn({ ui_locales: 'fr' })
      const step2 = await password(asked, 'anna.schmidt@example.com')
      const page = await asked.browser.request('GET', step2.headers.location as string)
      expect(page.body).toContain('<html lang="fr">')
      expect(page.body).toContain('par e-mail')
    })

    it('keeps the language for wrong codes and for the resend notice', async () => {
      const s = await startSignIn({ ui_locales: 'hu' })
      await password(s, 'ben.keller@example.com')
      const wrong = await s.browser.request('POST', `${s.interaction}/code`, { form: { code: '000000' } })
      expect(wrong.body).toContain('<html lang="hu">')
      expect(wrong.body).toContain('nem helyes')
    })

    it('shows the expired page in the browser\'s language', async () => {
      const response = await new Browser(h.app).request('GET', '/interaction/unknown', { headers: { 'accept-language': 'de' } })
      expect(response.statusCode).toBe(400)
      expect(response.body).toContain('Anmeldung abgelaufen')
    })

    it('shows errors of the provider in the browser\'s language', async () => {
      const response = await new Browser(h.app).request('GET', '/auth?client_id=nobody&response_type=code', { headers: { 'accept-language': 'de' } })
      expect(response.body).toContain('<html lang="de">')
      expect(response.body).toContain('Etwas ist schiefgelaufen')
    })
  })

  describe('choosing a password', () => {
    const invitedIn = async (language: string) => {
      const email = `lang${++counter}@example.com`
      const created = (await h.api('POST', '/users', { body: { email, firstName: 'Léa', lastName: 'Test', language } })).json()
      await h.api('POST', `/users/${created.id}/activate`)
      const token = new URL(h.notifications.findLast((n) => n.kind === 'activation')!.url!).searchParams.get('token')!
      return { email, token }
    }

    it('uses the language of the user the link belongs to', async () => {
      const { token } = await invitedIn('fr')
      const page = await new Browser(h.app).request('GET', `/activate?token=${token}`, { headers: { 'accept-language': 'de' } })
      expect(page.body).toContain('<html lang="fr">')
      expect(page.body).toContain('Choisir votre mot de passe')

      const mistake = await new Browser(h.app).request('POST', '/activate', { form: { token, password: 'short', confirm: 'short' } })
      expect(mistake.statusCode).toBe(422)
      expect(mistake.body).toContain('au moins 10 caractères')

      const done = await new Browser(h.app).request('POST', '/activate', { form: { token, password: 'correct horse battery', confirm: 'correct horse battery' } })
      expect(done.body).toContain('Votre compte est actif')
    })

    it('shows the invalid-link page in the browser\'s language', async () => {
      const page = await new Browser(h.app).request('GET', '/activate?token=nonsense', { headers: { 'accept-language': 'hu' } })
      expect(page.statusCode).toBe(400)
      expect(page.body).toContain('Érvénytelen hivatkozás')
    })
  })

  describe('forgotten password', () => {
    it('follows lang in the link and the browser, and passes the language on from page to page', async () => {
      const first = await new Browser(h.app).request('GET', '/reset?lang=fr')
      expect(first.body).toContain('<html lang="fr">')
      expect(first.body).toContain('name="lang" value="fr"')

      const second = await new Browser(h.app).request('POST', '/reset', { form: { email: 'nobody@example.com', lang: 'fr' } })
      expect(second.body).toContain('<html lang="fr">')
      expect(second.body).toContain('lang=fr')

      expect((await new Browser(h.app).request('GET', '/reset', { headers: { 'accept-language': 'hu' } })).body).toContain('<html lang="hu">')
    })

    it('does not give away whether the address has an account through the language', async () => {
      // anna's own language is German; she must not get German where a stranger gets English
      const known = await new Browser(h.app).request('POST', '/reset', { form: { email: 'anna.schmidt@example.com', lang: 'en' } })
      const unknown = await new Browser(h.app).request('POST', '/reset', { form: { email: 'nobody@example.com', lang: 'en' } })
      expect(known.body).toContain('<html lang="en">')
      expect(unknown.body).toContain('<html lang="en">')
    })

    it('sends the user to the page in their own language from the mail', async () => {
      const id = (await h.database.pool.query(`select id from users where email = 'greta.lang@example.com'`)).rows[0].id as string
      await h.api('POST', `/users/${id}/reset-password`)
      const url = new URL(h.notifications.findLast((n) => n.kind === 'reset-code')!.url!)
      expect(url.searchParams.get('lang')).toBe('de')
      const page = await new Browser(h.app).request('GET', `${url.pathname}${url.search}`)
      expect(page.body).toContain('<html lang="de">')
    })
  })
})
