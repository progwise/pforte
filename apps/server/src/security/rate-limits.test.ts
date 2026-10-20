import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { basicAuth, Browser, pkcePair } from '../test/browser.js'

const WEB = { clientId: 'demo-web', redirectUri: 'http://localhost:3400/callback' }
const ATTACKER = '203.0.113.7'
const OTHER = '198.51.100.1'

describe.skipIf(!hasDatabase)('rate limits', () => {
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
    await h.database.pool.query(`update users set status = 'active' where password_hash is not null`)
  })

  const hits = async (prefix: string) =>
    Number((await h.database.pool.query(`select coalesce(sum(hits), 0) as hits from rate_limits where key like $1`, [`${prefix}%`])).rows[0].hits)

  const startSignIn = async (locale = 'en') => {
    const browser = new Browser(h.app)
    const query = new URLSearchParams({
      client_id: WEB.clientId,
      redirect_uri: WEB.redirectUri,
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
  const tryPassword = (s: Awaited<ReturnType<typeof startSignIn>>, email: string, password: string, ip = ATTACKER) =>
    s.browser.request('POST', `${s.interaction}/login`, { form: { email, password }, ip })

  describe('passwords', () => {
    it('throttles a brute force script after five wrong passwords, and says how long to wait', async () => {
      const s = await startSignIn()
      for (let attempt = 1; attempt <= 5; attempt++) {
        expect((await tryPassword(s, 'anna.schmidt@example.com', `guess-${attempt}`)).statusCode, `attempt ${attempt}`).toBe(401)
      }

      const blocked = await tryPassword(s, 'anna.schmidt@example.com', 'guess-6')
      expect(blocked.statusCode).toBe(429)
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(890)
      expect(blocked.body).toContain('Too many attempts')
      expect(blocked.body).toContain('15 minutes')
      expect(blocked.headers['cache-control']).toBe('no-store')
    })

    it('does not look at the password while an address is held back, so even the right one is refused', async () => {
      const s = await startSignIn()
      for (let attempt = 0; attempt < 5; attempt++) await tryPassword(s, 'anna.schmidt@example.com', 'wrong')

      expect((await tryPassword(s, 'anna.schmidt@example.com', 'dev-password')).statusCode).toBe(429)
      // from another network the same address is fine
      expect((await tryPassword(s, 'anna.schmidt@example.com', 'dev-password', OTHER)).statusCode).toBe(303)
    })

    it('holds back unknown and known addresses in the same way, so it shows nothing about who has an account', async () => {
      const run = async (email: string) => {
        await h.database.pool.query('delete from rate_limits')
        const s = await startSignIn()
        const statuses: number[] = []
        for (let attempt = 0; attempt < 6; attempt++) statuses.push((await tryPassword(s, email, 'wrong')).statusCode)
        const last = await tryPassword(s, email, 'wrong')
        return { statuses, body: last.body, wait: Number(last.headers['retry-after']) }
      }
      const known = await run('anna.schmidt@example.com')
      const unknown = await run('nobody.at.all@example.com')

      expect(known.statuses).toEqual([401, 401, 401, 401, 401, 429])
      expect(unknown.statuses).toEqual(known.statuses)
      expect(unknown.body).toBe(known.body)
      expect(Math.abs(unknown.wait - known.wait)).toBeLessThanOrEqual(2)
    })

    it('answers in the language of the page', async () => {
      const s = await startSignIn('de')
      for (let attempt = 0; attempt < 5; attempt++) await tryPassword(s, 'ben.keller@example.com', 'wrong')
      const blocked = await tryPassword(s, 'ben.keller@example.com', 'wrong')
      expect(blocked.statusCode).toBe(429)
      expect(blocked.body).toContain('Zu viele Versuche')
    })

    it('forgives mistakes after a right password, so a person who mistyped sometimes is not held back', async () => {
      const s = await startSignIn()
      for (let attempt = 0; attempt < 4; attempt++) await tryPassword(s, 'felix.brandt@example.com', 'wrong')
      expect((await tryPassword(s, 'felix.brandt@example.com', 'dev-password')).statusCode).toBe(303)
      expect(await hits('pw:addrip:')).toBe(0)
    })
  })

  describe('codes', () => {
    const atCodeStep = async (email: string) => {
      const s = await startSignIn()
      const password = await tryPassword(s, email, 'dev-password', OTHER)
      expect(password.headers.location).toBe(`${s.interaction}/code`)
      await h.database.pool.query('delete from rate_limits')
      return s
    }

    it('holds an IP back after 30 wrong codes, even when the next one is right', async () => {
      const email = 'greta.lang@example.com'
      const s = await atCodeStep(email)
      const right = h.notifications.findLast((n) => n.kind === 'login-code' && n.user.email === email)!.code!
      const wrong = right === '000000' ? '000001' : '000000'

      for (let attempt = 1; attempt <= 30; attempt++) {
        const response = await s.browser.request('POST', `${s.interaction}/code`, { form: { code: wrong }, ip: ATTACKER })
        expect(response.statusCode, `attempt ${attempt}`).toBe(401)
      }
      const blocked = await s.browser.request('POST', `${s.interaction}/code`, { form: { code: right }, ip: ATTACKER })
      expect(blocked.statusCode).toBe(429)
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
    })

    it('counts a mistyped code that is not six digits, but not a code that is only unused', async () => {
      const s = await atCodeStep('hans.weber@example.com')
      await s.browser.request('POST', `${s.interaction}/code`, { form: { code: 'abc' }, ip: ATTACKER })
      expect(await hits('code:ip:')).toBe(1)
    })

    it('allows ten requests for another code an hour per IP, across users', async () => {
      // each user alone is held back earlier (five unused codes an hour), so spread them over four
      const emails = ['ben.keller', 'anna.schmidt', 'felix.brandt', 'hans.weber'].map((name) => `${name}@example.com`)
      const sessions: Awaited<ReturnType<typeof atCodeStep>>[] = []
      for (const email of emails) sessions.push(await atCodeStep(email))

      let resends = 0
      const resend = async (s: (typeof sessions)[number]) => {
        await h.database.pool.query(`update otp_codes set created_at = created_at - interval '2 minutes'`)
        resends++
        return s.browser.request('POST', `${s.interaction}/code/resend`, { ip: ATTACKER })
      }
      for (let n = 0; n < 10; n++) expect((await resend(sessions[n % 4]!)).statusCode, `resend ${n + 1}`).toBe(200)

      const blocked = await resend(sessions[0]!)
      expect(resends).toBe(11)
      expect(blocked.statusCode).toBe(429)
      expect(blocked.body).toContain('Too many attempts')
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(3500)
    })

    it('answers a user who asks too often for their own code with the wait, not the IP limit', async () => {
      const s = await atCodeStep('ben.keller@example.com')
      for (let n = 0; n < 4; n++) {
        await h.database.pool.query(`update otp_codes set created_at = created_at - interval '2 minutes'`)
        expect((await s.browser.request('POST', `${s.interaction}/code/resend`, { ip: ATTACKER })).statusCode).toBe(200)
      }
      await h.database.pool.query(`update otp_codes set created_at = created_at - interval '2 minutes'`)
      const tooMany = await s.browser.request('POST', `${s.interaction}/code/resend`, { ip: ATTACKER })
      expect(tooMany.statusCode).toBe(429)
      expect(tooMany.body).toContain('Too many codes were requested')
    })

    it('does not count the first code of a sign-in, so a whole office can sign in from one address', async () => {
      for (let person = 0; person < 12; person++) {
        const s = await startSignIn()
        const email = ['anna.schmidt', 'ben.keller', 'felix.brandt', 'greta.lang', 'hans.weber'][person % 5] + '@example.com'
        await h.database.pool.query('delete from otp_codes')
        const response = await tryPassword(s, email, 'dev-password', ATTACKER)
        expect(response.statusCode, `person ${person}`).toBe(303)
      }
    })
  })

  describe('password reset', () => {
    const request = (email: string, ip = ATTACKER) => new Browser(h.app).request('POST', '/reset', { form: { email, lang: 'en' }, ip })

    it('allows five requests an hour for an address and answers the same for every address', async () => {
      const results: Record<string, { statuses: number[]; body: string }> = {}
      for (const email of ['anna.schmidt@example.com', 'nobody@example.com']) {
        await h.database.pool.query('delete from rate_limits')
        const statuses: number[] = []
        for (let n = 0; n < 6; n++) statuses.push((await request(email, `198.51.100.${n + 10}`)).statusCode)
        const last = await request(email, '198.51.100.99')
        results[email] = { statuses, body: last.body }
      }

      expect(results['anna.schmidt@example.com']!.statuses).toEqual([200, 200, 200, 200, 200, 429])
      expect(results['nobody@example.com']!.statuses).toEqual([200, 200, 200, 200, 200, 429])
      expect(results['nobody@example.com']!.body).toBe(results['anna.schmidt@example.com']!.body)
    })

    it('allows 30 an hour from one IP, for different addresses', async () => {
      for (let n = 0; n < 30; n++) expect((await request(`person${n}@example.com`)).statusCode, `request ${n}`).toBe(200)
      const blocked = await request('person31@example.com')
      expect(blocked.statusCode).toBe(429)
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(3500)
    })

    it('holds an IP back after 30 wrong reset codes', async () => {
      for (let n = 0; n < 30; n++) {
        await new Browser(h.app).request('POST', '/reset/code', {
          form: { email: 'anna.schmidt@example.com', code: '000000', password: 'a long enough password', confirm: 'a long enough password' },
          ip: ATTACKER,
        })
      }
      const blocked = await new Browser(h.app).request('POST', '/reset/code', {
        form: { email: 'anna.schmidt@example.com', code: '000000', password: 'a long enough password', confirm: 'a long enough password' },
        ip: ATTACKER,
      })
      expect(blocked.statusCode).toBe(429)
    })

    it('does not count a password that was refused for being too short', async () => {
      for (let n = 0; n < 40; n++) {
        const response = await new Browser(h.app).request('POST', '/reset/code', {
          form: { email: 'anna.schmidt@example.com', code: '000000', password: 'short', confirm: 'short' },
          ip: ATTACKER,
        })
        expect(response.statusCode).toBe(422)
      }
    })
  })

  describe('activation', () => {
    it('holds an IP back after 20 wrong links, also for a right one, and not other IPs', async () => {
      const email = 'rate.limit.invite@example.com'
      const created = (await h.api('POST', '/users', { body: { email, firstName: 'R', lastName: 'L' } })).json()
      await h.api('POST', `/users/${created.id}/activate`)
      const token = new URL(h.notifications.findLast((n) => n.kind === 'activation')!.url!).searchParams.get('token')!

      for (let n = 0; n < 20; n++) {
        expect((await new Browser(h.app).request('GET', `/activate?token=wrong-${n}`, { ip: ATTACKER })).statusCode).toBe(400)
      }
      const blocked = await new Browser(h.app).request('GET', `/activate?token=${token}`, { ip: ATTACKER })
      expect(blocked.statusCode).toBe(429)
      expect(blocked.headers['retry-after']).toBeDefined()

      expect((await new Browser(h.app).request('GET', `/activate?token=${token}`, { ip: OTHER })).statusCode).toBe(200)
    })
  })

  describe('applications and administrators', () => {
    const tokenRequest = (secret: string, ip = ATTACKER) =>
      new Browser(h.app).request('POST', '/token', {
        form: { grant_type: 'client_credentials', scope: 'directory' },
        headers: { authorization: basicAuth('demo-import', secret) },
        ip,
      })

    it('holds an IP back after 30 wrong client secrets at the token endpoint', async () => {
      for (let n = 0; n < 30; n++) expect((await tokenRequest(`wrong-${n}`)).statusCode).toBe(401)
      // the failures are counted when the answer has been sent
      await vi.waitFor(async () => expect(await hits('clientauth:ip:')).toBe(30))

      const blocked = await tokenRequest('dev-secret')
      expect(blocked.statusCode).toBe(429)
      expect(blocked.json()).toMatchObject({ error: 'temporarily_unavailable' })
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)

      expect((await tokenRequest('dev-secret', OTHER)).statusCode).toBe(200)
    })

    it('does not count what the token endpoint refuses for other reasons', async () => {
      for (let n = 0; n < 5; n++) {
        const response = await new Browser(h.app).request('POST', '/token', {
          form: { grant_type: 'password' },
          headers: { authorization: basicAuth('demo-import', 'dev-secret') },
          ip: ATTACKER,
        })
        expect(response.statusCode).toBe(400)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(await hits('clientauth:ip:')).toBe(0)
    })

    it('holds an IP back after 30 wrong tokens at the admin API, but never an administrator with a valid one', async () => {
      const call = (token: string, ip: string) =>
        h.app.inject({ method: 'GET', url: '/admin/users?limit=1', headers: { authorization: `Bearer ${token}` }, remoteAddress: ip })

      for (let n = 0; n < 30; n++) expect((await call(`wrong-${n}`, ATTACKER)).statusCode).toBe(401)
      const blocked = await call('wrong-again', ATTACKER)
      expect(blocked.statusCode).toBe(429)
      expect(blocked.headers['content-type']).toContain('application/problem+json')
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
      expect(blocked.json()).toMatchObject({ status: 429, title: 'Too many requests' })

      expect((await call(h.adminToken, ATTACKER)).statusCode).toBe(200)
      expect((await call(h.directoryToken, ATTACKER)).statusCode).toBe(200)
    })

    it('counts a request without a token as a failure too', async () => {
      await h.app.inject({ method: 'GET', url: '/admin/users', remoteAddress: ATTACKER })
      expect(await hits('clientauth:ip:')).toBe(1)
    })
  })

  describe('who is asking', () => {
    const appBehind = async (trustProxy: number) => {
      const app = buildApp({ getDatabaseTime: async () => new Date(), trustProxy })
      app.get('/ip', async (request) => request.ip)
      await app.ready()
      return app
    }
    const ask = async (app: Awaited<ReturnType<typeof appBehind>>, forwarded?: string) =>
      (await app.inject({ url: '/ip', remoteAddress: '10.0.0.5', headers: forwarded ? { 'x-forwarded-for': forwarded } : {} })).body

    it('ignores X-Forwarded-For unless pforte was told about a proxy, so it cannot be used to change address', async () => {
      const direct = await appBehind(0)
      expect(await ask(direct, '203.0.113.99')).toBe('10.0.0.5')
      expect(await ask(direct)).toBe('10.0.0.5')
    })

    it('takes the address the one proxy reports, and the one before the last proxy for two', async () => {
      const one = await appBehind(1)
      expect(await ask(one, '203.0.113.99')).toBe('203.0.113.99')
      // a client that adds its own entry in front cannot choose the address that counts
      expect(await ask(one, '1.1.1.1, 203.0.113.99')).toBe('203.0.113.99')

      const two = await appBehind(2)
      expect(await ask(two, '1.1.1.1, 203.0.113.99, 192.168.1.1')).toBe('203.0.113.99')
    })
  })
})
