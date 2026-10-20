import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLoginAudit } from '../auth/login-audit.js'
import { NotifierUnavailableError } from '../notifications/notifier.js'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { Browser, pkcePair, signIn } from '../test/browser.js'

const WEB = { clientId: 'demo-web', redirectUri: 'http://localhost:3400/callback' }
const ATTACKER = '203.0.113.7'

describe.skipIf(!hasDatabase)('the sign-in audit', () => {
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
    h.notifier.failSms = false
    await h.database.pool.query('delete from rate_limits')
    await h.database.pool.query('delete from otp_codes')
    await h.database.pool.query('delete from devices')
    await h.database.pool.query(`delete from audit_events where action like 'login.%' or action = 'user.password_reset.request'`)
    await h.database.pool.query(`update users set status = 'active', phone = null, phone_verified_at = null where password_hash is not null`)
  })

  const events = async (pattern = 'login.%') =>
    (await h.database.pool.query(`select * from audit_events where action like $1 order by created_at, id`, [pattern])).rows as {
      action: string
      actor_type: string
      actor_id: string | null
      target_type: string | null
      target_id: string | null
      details: Record<string, unknown>
      ip: string | null
      user_agent: string | null
    }[]
  const userId = async (email: string) => (await h.database.pool.query(`select id from users where email = $1`, [email])).rows[0].id as string

  const start = async () => {
    const browser = new Browser(h.app)
    const query = new URLSearchParams({
      client_id: WEB.clientId,
      redirect_uri: WEB.redirectUri,
      response_type: 'code',
      scope: 'openid',
      state: 's',
      nonce: 'n',
      ui_locales: 'en',
      code_challenge: pkcePair().challenge,
      code_challenge_method: 'S256',
    })
    const interaction = (await browser.request('GET', `/auth?${query}`)).headers.location as string
    await browser.request('GET', interaction)
    return { browser, interaction }
  }
  const password = (s: Awaited<ReturnType<typeof start>>, email: string, secret: string, ip = ATTACKER) =>
    s.browser.request('POST', `${s.interaction}/login`, { form: { email, password: secret }, ip, headers: { 'user-agent': 'brute-force/1.0' } })

  describe('passwords', () => {
    it('shows a brute force script in the audit log: every failure, and the moment it was held back', async () => {
      const s = await start()
      for (let attempt = 1; attempt <= 7; attempt++) await password(s, 'anna.schmidt@example.com', `guess-${attempt}`)

      const log = await events()
      const failed = log.filter((event) => event.action === 'login.password_failed')
      const blocked = log.filter((event) => event.action === 'login.blocked')
      const id = await userId('anna.schmidt@example.com')

      expect(failed).toHaveLength(5)
      for (const event of failed) {
        expect(event).toMatchObject({ target_type: 'user', target_id: id, ip: ATTACKER, user_agent: 'brute-force/1.0' })
        expect(event.details).toEqual({ reason: 'wrong_password' })
      }
      // refused again and again, but written once
      expect(blocked).toHaveLength(1)
      expect(blocked[0]).toMatchObject({ target_id: id, ip: ATTACKER })
      expect(blocked[0]!.details).toEqual({ scope: 'password' })
    })

    it('is visible to an administrator through the API, filtered by action and by user', async () => {
      const s = await start()
      for (let attempt = 1; attempt <= 6; attempt++) await password(s, 'ben.keller@example.com', 'wrong')
      const id = await userId('ben.keller@example.com')

      const byAction = (await h.api('GET', '/audit-events?action=login.*&limit=50')).json()
      expect(byAction.items.map((event: { action: string }) => event.action)).toEqual(
        expect.arrayContaining(['login.password_failed', 'login.blocked']),
      )
      const forUser = (await h.api('GET', `/audit-events?targetType=user&targetId=${id}&action=login.*`)).json()
      expect(forUser.items.length).toBe(6)
      expect(forUser.items[0]).toMatchObject({ ip: ATTACKER, userAgent: 'brute-force/1.0' })
    })

    it('does not store an address that no user has, only a hash, and the hash is the same for the same address', async () => {
      const s = await start()
      await password(s, 'nobody@example.com', 'wrong')
      await password(s, 'Nobody@Example.com ', 'wrong')
      await password(s, 'hunter2-typed-in-the-email-field', 'wrong')

      const log = await events('login.password_failed')
      expect(log).toHaveLength(3)
      for (const event of log) {
        expect(event.target_id).toBeNull()
        expect(event.details).toMatchObject({ reason: 'unknown_user', emailHash: expect.stringMatching(/^[0-9a-f]{16}$/) })
      }
      expect(log[0]!.details.emailHash).toBe(log[1]!.details.emailHash)
      expect(log[2]!.details.emailHash).not.toBe(log[0]!.details.emailHash)
      expect(JSON.stringify(log)).not.toMatch(/nobody|hunter2/i)
    })

    it('tells the reason, so an administrator sees a try on a locked account', async () => {
      const id = await userId('felix.brandt@example.com')
      await h.api('POST', `/users/${id}/lock`)
      const s = await start()
      await password(s, 'felix.brandt@example.com', 'dev-password')

      const [event] = await events('login.password_failed')
      expect(event).toMatchObject({ target_id: id })
      expect(event!.details).toEqual({ reason: 'not_allowed' })
    })

    it('records a block of an unknown address without the address', async () => {
      const s = await start()
      for (let attempt = 0; attempt < 6; attempt++) await password(s, 'nobody@example.com', 'wrong')
      const [blocked] = await events('login.blocked')
      expect(blocked!.target_id).toBeNull()
      expect(blocked!.details).toMatchObject({ scope: 'password', emailHash: expect.stringMatching(/^[0-9a-f]{16}$/) })
      expect(JSON.stringify(blocked)).not.toContain('nobody')
    })
  })

  describe('signing in with a code', () => {
    it('records the code that was sent and the sign-in that followed, with how strong it was', async () => {
      const email = 'greta.lang@example.com'
      await signIn(new Browser(h.app), { ...WEB, email })
      const id = await userId(email)

      const log = (await events()).map((event) => [event.action, event.details])
      expect(log).toEqual([
        ['login.code_sent', { purpose: 'login', channel: 'email' }],
        ['login.succeeded', { method: 'code', channel: 'email', acr: 'urn:pforte:acr:mfa' }],
      ])
      expect((await events()).every((event) => event.target_id === id && event.actor_id === id)).toBe(true)
    })

    it('records wrong codes, with the reason, and the sixth attempt as exhausted', async () => {
      const email = 'hans.weber@example.com'
      const s = await start()
      await password(s, email, 'dev-password', '198.51.100.1')
      const right = h.notifications.findLast((n) => n.kind === 'login-code')!.code!
      const wrong = right === '000000' ? '000001' : '000000'
      for (let attempt = 0; attempt < 6; attempt++) await s.browser.request('POST', `${s.interaction}/code`, { form: { code: wrong } })

      const failures = await events('login.code_failed')
      expect(failures.map((event) => event.details.reason)).toEqual(['wrong', 'wrong', 'wrong', 'wrong', 'wrong', 'exhausted'])
      expect(failures[0]!.details.purpose).toBe('login')
      expect(await events('login.succeeded')).toHaveLength(0)
    })

    it('records the channel, and that an SMS fell back to e-mail', async () => {
      const email = 'anna.schmidt@example.com'
      await h.database.pool.query(`update users set phone = '+4915112345678', phone_verified_at = now() where email = $1`, [email])
      h.notifier.smsAvailable = true
      await signIn(new Browser(h.app), { ...WEB, email })
      expect((await events('login.code_sent'))[0]!.details).toEqual({ purpose: 'login', channel: 'sms' })
      expect((await events('login.succeeded'))[0]!.details).toMatchObject({ method: 'code', channel: 'sms' })

      await h.database.pool.query(`delete from audit_events where action like 'login.%'`)
      await h.database.pool.query('delete from otp_codes')
      h.notifier.failSms = true
      await signIn(new Browser(h.app), { ...WEB, email })
      expect((await events('login.code_sent'))[0]!.details).toEqual({ purpose: 'login', channel: 'email', fellBackToEmail: true })
    })

    it('records a sign-in on a remembered device as such, with the weaker assurance', async () => {
      const email = 'ben.keller@example.com'
      const first = new Browser(h.app)
      const s = await start()
      void first
      await password(s, email, 'dev-password', '198.51.100.1')
      const code = h.notifications.findLast((n) => n.kind === 'login-code')!.code!
      const done = await s.browser.request('POST', `${s.interaction}/code`, { form: { code, remember: 'on' } })
      expect(done.statusCode).toBe(303)
      await h.database.pool.query(`delete from audit_events where action like 'login.%'`)

      // a new visit in the same browser: the single sign-on session is gone, the device is remembered
      for (const name of s.browser.cookies.keys()) if (name !== 'pforte_device') s.browser.cookies.delete(name)
      const again = new Browser(h.app)
      for (const [name, value] of s.browser.cookies) again.cookies.set(name, value)
      const second = await (async () => {
        const query = new URLSearchParams({ client_id: WEB.clientId, redirect_uri: WEB.redirectUri, response_type: 'code', scope: 'openid', code_challenge: pkcePair().challenge, code_challenge_method: 'S256', ui_locales: 'en' })
        const interaction = (await again.request('GET', `/auth?${query}`)).headers.location as string
        await again.request('GET', interaction)
        return again.request('POST', `${interaction}/login`, { form: { email, password: 'dev-password' } })
      })()
      expect(second.statusCode).toBe(303)

      const log = await events()
      expect(log.map((event) => event.action)).toEqual(['login.succeeded'])
      expect(log[0]!.details).toEqual({ method: 'remembered_device', acr: 'urn:pforte:acr:pwd' })
    })
  })

  describe('password reset', () => {
    it('records that a reset was asked for and where the code went, for a real account only', async () => {
      const id = await userId('greta.lang@example.com')
      await new Browser(h.app).request('POST', '/reset', { form: { email: 'greta.lang@example.com', lang: 'en' }, ip: ATTACKER })
      await new Browser(h.app).request('POST', '/reset', { form: { email: 'nobody@example.com', lang: 'en' }, ip: ATTACKER })
      await h.settle()

      const requested = await events('user.password_reset.request')
      expect(requested).toHaveLength(1)
      expect(requested[0]).toMatchObject({ target_id: id, ip: ATTACKER, details: { self: true } })
      expect((await events('login.code_sent')).map((event) => event.details)).toEqual([{ purpose: 'password_reset', channel: 'email' }])
    })

    it('records wrong reset codes, also for an address without an account, as a hash', async () => {
      const post = (email: string) =>
        new Browser(h.app).request('POST', '/reset/code', {
          form: { email, code: '000000', password: 'a long enough password', confirm: 'a long enough password' },
          ip: ATTACKER,
        })
      await post('greta.lang@example.com')
      await post('nobody@example.com')

      const [known, unknown] = await events('login.code_failed')
      expect(known).toMatchObject({ target_id: await userId('greta.lang@example.com') })
      expect(known!.details).toMatchObject({ purpose: 'password_reset', reason: 'none' })
      expect(unknown!.target_id).toBeNull()
      expect(unknown!.details).toMatchObject({ purpose: 'password_reset', reason: 'unknown_user', emailHash: expect.stringMatching(/^[0-9a-f]{16}$/) })
      expect(JSON.stringify(unknown)).not.toContain('nobody')
    })

    it('records that reset requests were held back', async () => {
      for (let n = 0; n < 6; n++) await new Browser(h.app).request('POST', '/reset', { form: { email: 'nobody@example.com', lang: 'en' }, ip: `198.51.100.${n}` })
      const blocked = await events('login.blocked')
      expect(blocked).toHaveLength(1)
      expect(blocked[0]!.details).toMatchObject({ scope: 'reset' })
    })
  })

  describe('when the log cannot be written', () => {
    it('never stops a sign-in: the failure is reported and nothing is thrown', async () => {
      const broken = new Proxy({}, { get: () => () => { throw new Error('database is gone') } }) as never
      const onError = vi.fn()
      const audit = createLoginAudit({ db: broken, secret: 's', onError })
      const origin = { ip: ATTACKER }

      await audit.passwordFailed(origin, { email: 'a@b.c', reason: 'wrong_password' })
      await audit.blocked(origin, { scope: 'password', email: 'a@b.c' })
      await audit.codeSent(origin, { userId: 'u', purpose: 'login', channel: 'email' })
      await audit.codeFailed(origin, { userId: 'u', purpose: 'login', reason: 'wrong' })
      await audit.succeeded(origin, { userId: 'u', method: 'code', acr: 'x' })
      await audit.resetRequested(origin, { userId: 'u' })

      expect(onError).toHaveBeenCalledTimes(6)
    })
  })

  describe('unlocking', () => {
    it('lets an address try again at once after too many mistakes, and records who did it', async () => {
      const email = 'anna.schmidt@example.com'
      const id = await userId(email)
      const s = await start()
      for (let attempt = 0; attempt < 5; attempt++) await password(s, email, 'wrong')
      expect((await password(s, email, 'dev-password')).statusCode).toBe(429)

      const response = await h.api('POST', `/users/${id}/unlock`)
      expect(response.statusCode).toBe(200)
      expect(response.json().status).toBe('active')

      expect((await password(s, email, 'dev-password')).statusCode).toBe(303)
      const unlocks = await h.audit('user.unlock', id)
      expect(unlocks).toHaveLength(1)
      expect(unlocks[0].details).toMatchObject({ from: 'active', to: 'active' })
    })

    it('forgets the attempts of that address only', async () => {
      const s = await start()
      for (let attempt = 0; attempt < 5; attempt++) {
        await password(s, 'anna.schmidt@example.com', 'wrong')
        await password(s, 'ben.keller@example.com', 'wrong')
      }
      await h.api('POST', `/users/${await userId('anna.schmidt@example.com')}/unlock`)

      expect((await password(s, 'anna.schmidt@example.com', 'dev-password')).statusCode).toBe(303)
      expect((await password(s, 'ben.keller@example.com', 'dev-password')).statusCode).toBe(429)
    })

    it('also ends the lock of an administrator, and forgets the attempts as well', async () => {
      const email = 'felix.brandt@example.com'
      const id = await userId(email)
      await h.api('POST', `/users/${id}/lock`)
      const s = await start()
      for (let attempt = 0; attempt < 5; attempt++) await password(s, email, 'wrong')

      expect((await h.api('POST', `/users/${id}/unlock`)).json().status).toBe('active')
      expect((await password(s, email, 'dev-password')).statusCode).toBe(303)
    })

    it('still refuses a user who is deactivated', async () => {
      const email = 'hans.weber@example.com'
      const id = await userId(email)
      await h.api('POST', `/users/${id}/deactivate`)
      const response = await h.api('POST', `/users/${id}/unlock`)
      expect(response.statusCode).toBe(409)
      await h.database.pool.query(`update users set status = 'active' where id = $1`, [id])
    })
  })

  it('does not fail a sign-in when the code cannot be sent, and records nothing about a code that was not sent', async () => {
    h.notifier.failWith = new NotifierUnavailableError('down')
    const s = await start()
    const response = await password(s, 'greta.lang@example.com', 'dev-password', '198.51.100.1')
    h.notifier.failWith = undefined
    expect(response.statusCode).toBe(503)
    expect(await events('login.code_sent')).toHaveLength(0)
  })
})
