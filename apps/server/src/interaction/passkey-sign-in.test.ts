import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type AdminHarness, createAdminHarness, ISSUER } from '../test/admin-harness.js'
import { createAuthenticator, type SignInOptions } from '../test/authenticator.js'
import { Browser, signIn } from '../test/browser.js'
import { driveSignIn } from '../test/manage-session.js'
import { enrol, openLogin, post, tokensAfter, WEB } from '../test/passkey-flows.js'

const A = { email: 'anna.schmidt@example.com' }
const B = { email: 'ben.keller@example.com' }

describe.skipIf(!hasDatabase)('signing in with a passkey', () => {
  let h: AdminHarness
  let annaId: string
  /** Anna's phone, with her passkey on it. */
  const phone = createAuthenticator({ origin: ISSUER })

  beforeAll(async () => {
    h = await createAdminHarness()
    annaId = (await h.database.pool.query(`select id from users where email = $1`, [A.email])).rows[0].id
    await h.database.pool.query(`update users set language = 'en' where email in ($1, $2)`, [A.email, B.email])
    await enrol(h, phone, A.email)
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(async () => {
    await h.settle()
    h.notifications.length = 0
    await h.database.pool.query('delete from rate_limits')
    await h.database.pool.query('delete from otp_codes')
    await h.database.pool.query(`delete from audit_events where action like 'login.%'`)
    await h.database.pool.query(`delete from oidc_payloads where account_id is not null`)
    await h.database.pool.query(`update users set status = 'active', locked_at = null, last_login_at = null where email = $1`, [A.email])
    await h.database.pool.query(`update passkeys set counter = 0, last_used_at = null, synced = false`)
  })

  const passkey = async () => (await h.database.pool.query(`select * from passkeys where credential_id = $1`, [phone.newest])).rows[0]
  const events = async (action: string) => (await h.database.pool.query(`select * from audit_events where action = $1 order by id`, [action])).rows
  /** Starts a sign-in to the web application and answers the question of the login page with the phone. */
  const attempt = async (browser = new Browser(h.app), answer: SignInOptions = {}) => {
    const login = await openLogin(browser)
    const response = await post(browser, `${login.interaction}/passkey`, { credential: JSON.stringify(phone.get(login.question, answer)) })
    return { browser, response, ...login }
  }

  describe('the login page', () => {
    it('asks the device for any passkey it holds for pforte, checked by the device, and names nobody', async () => {
      const { question, page } = await openLogin(new Browser(h.app))

      expect(question).toMatchObject({ rpId: 'localhost', userVerification: 'required', allowCredentials: [] })
      expect(Buffer.from(question.challenge, 'base64url').length).toBeGreaterThanOrEqual(16)
      expect(page.body).toContain('autocomplete="username webauthn"')
      expect(page.body).toMatch(/<form method="post" action="\/interaction\/[^"]+\/passkey" data-passkey="get" data-options="[^"]*" hidden>/)
      expect(page.body).toContain('<button type="submit" class="secondary">Sign in with a passkey</button>')
    })

    it('is the page of before for a browser without script: the passkey form is hidden, password and code work', async () => {
      const { page } = await openLogin(new Browser(h.app))
      // What is visible without the script: everything but the form that the script unhides.
      const visible = page.body.replace(/<form[^>]*data-passkey="get"[^>]*hidden>[\s\S]*?<\/form>\n/, '').replace(/\n<script[^>]*><\/script>/, '')
      expect(visible).not.toContain('passkey')
      expect(visible).toContain('name="password"')

      const result = await signIn(new Browser(h.app), { ...WEB, email: B.email })
      expect(result.code).toBeTruthy()
    })

    it('may run the one script and nothing else', async () => {
      const { page } = await openLogin(new Browser(h.app))

      expect(page.headers['content-security-policy']).toBe(h.passkeys.script.policy)
      expect(page.body.match(/<script/g)).toHaveLength(1)
      expect(page.body).toContain(h.passkeys.script.tag)
    })

    it('has one question per sign-in, the newest: showing the page again replaces it', async () => {
      const browser = new Browser(h.app)
      const first = await openLogin(browser)
      const again = await browser.request('GET', first.interaction)
      const second = /data-options="([^"]*)"/.exec(again.body)![1]!

      const open = (await h.database.pool.query(`select challenge from passkey_challenges where bound_to = $1`, [`sign-in:${first.interaction.split('/').pop()}`])).rows
      expect(open).toHaveLength(1)
      expect(second).toContain(open[0].challenge)
      expect(open[0].challenge).not.toBe(first.question.challenge)

      const response = await post(browser, `${first.interaction}/passkey`, { credential: JSON.stringify(phone.get(first.question)) })
      expect(response.statusCode).toBe(401)
    })
  })

  describe('a right answer', () => {
    it('signs the person in at once, as with two factors, without password and without code', async () => {
      const { browser, response, verifier } = await attempt()

      const { claims } = await tokensAfter(browser, response, verifier)
      expect(claims).toMatchObject({ sub: annaId, acr: 'urn:pforte:acr:mfa', amr: ['pop', 'mfa'] })
      expect(h.notifications.filter((notification) => notification.kind === 'login-code')).toEqual([])
    })

    it('is recorded as a sign-in with a passkey, and the passkey as used', async () => {
      await attempt(new Browser(h.app), { synced: true })

      const [event] = await events('login.succeeded')
      expect(event).toMatchObject({ actor_id: annaId, target_id: annaId })
      expect(event.details).toEqual({ method: 'passkey', acr: 'urn:pforte:acr:mfa' })
      const used = await passkey()
      expect(used.last_used_at.getTime()).toBeGreaterThan(Date.now() - 60_000)
      // What the device says about syncing now is noted too.
      expect(used.synced).toBe(true)
      expect((await h.database.pool.query(`select last_login_at from users where id = $1`, [annaId])).rows[0].last_login_at).not.toBeNull()
    })

    it('satisfies an application that asks for the second factor, and one that asks for a new sign-in', async () => {
      const browser = new Browser(h.app)
      const first = await openLogin(browser, { extra: { acr_values: 'urn:pforte:acr:mfa' } })
      const one = await tokensAfter(browser, await post(browser, `${first.interaction}/passkey`, { credential: JSON.stringify(phone.get(first.question)) }), first.verifier)
      expect(one.claims.acr).toBe('urn:pforte:acr:mfa')

      // Signed in already, asked to sign in again: the passkey does that too.
      const again = await openLogin(browser, { extra: { prompt: 'login' } })
      const two = await tokensAfter(browser, await post(browser, `${again.interaction}/passkey`, { credential: JSON.stringify(phone.get(again.question)) }), again.verifier)
      expect(two.claims).toMatchObject({ sub: annaId, acr: 'urn:pforte:acr:mfa' })
      expect(await events('login.succeeded')).toHaveLength(2)
    })

    it('opens the account pages and the administration, which insist on two factors', async () => {
      const browser = new Browser(h.app)
      // The helper would type password and code. It never gets there: the passkey is used on the login page.
      let url = '/account'
      for (let step = 0; step < 8; step++) {
        const response = await browser.request('GET', url)
        if (response.statusCode !== 303) {
          expect(response.statusCode).toBe(200)
          expect(response.body).toContain('Your account')
          break
        }
        url = response.headers.location as string
        if (/^\/interaction\/[^/]+$/.test(new URL(url, ISSUER).pathname)) {
          const page = await browser.request('GET', url)
          const question = JSON.parse(/data-options="([^"]*)"/.exec(page.body)![1]!.replaceAll('&quot;', '"'))
          url = (await post(browser, `${url}/passkey`, { credential: JSON.stringify(phone.get(question)) })).headers.location as string
        }
      }
      expect((await browser.request('GET', '/account/sessions')).body).toContain('>With a passkey</td>')
    })

    it('is listed for the person and for the administrator as a sign-in with a passkey', async () => {
      const { browser, response, verifier } = await attempt()
      await tokensAfter(browser, response, verifier)
      const account = new Browser(h.app)
      await driveSignIn(h, account, '/account', A.email)

      expect((await account.request('GET', '/account/sign-ins')).body).toContain('>Signed in with a passkey</td>')
      const sessions = (await h.api('GET', `/users/${annaId}/sessions`)).json().sessions as { amr: string[]; acr: string }[]
      expect(sessions.map((session) => session.amr)).toContainEqual(['pop', 'mfa'])
    })

    it('counts for a device that counts: a higher counter is stored', async () => {
      await attempt(new Browser(h.app), { counter: 7 })
      expect((await passkey()).counter).toBe('7')
    })
  })

  describe('is refused', () => {
    const refused = async ({ response, browser, interaction }: Awaited<ReturnType<typeof attempt>>, reason: string, whose?: string) => {
      expect(response.statusCode).toBe(401)
      expect(response.body).toContain('This passkey cannot sign in here. Use e-mail address and password.')
      // The page is the login page again, with a new question.
      expect(response.body).toContain('name="password"')
      expect(response.body).toContain('data-passkey="get"')
      const failures = await events('login.passkey_failed')
      expect(failures).toHaveLength(1)
      expect(failures[0].details).toEqual({ reason })
      expect(failures[0].target_id).toBe(whose ?? null)
      expect(await events('login.succeeded')).toEqual([])
      expect((await passkey()).last_used_at).toBeNull()
      // And nobody is signed in: the sign-in still waits at the login page.
      const still = await browser.request('GET', interaction)
      expect(still.statusCode).toBe(200)
    }

    it.each([
      ['made on a page of another origin', { origin: 'https://localhost.example.com' }],
      ['made on pforte\'s host but another port', { origin: 'https://localhost:3301' }],
      ['made for another host', { rpId: 'example.com' }],
      ['made without the device checking the person', { userVerified: false }],
      ['signed with another key', { forged: true }],
    ] satisfies [string, SignInOptions][])('when the answer was %s', async (_name, answer) => {
      await refused(await attempt(new Browser(h.app), answer), 'verification_failed', annaId)
    })

    it('when the device names another person than the passkey belongs to', async () => {
      const benId = (await h.database.pool.query(`select id from users where email = $1`, [B.email])).rows[0].id as string
      const handle = Buffer.from(benId.replaceAll('-', ''), 'hex').toString('base64url')
      await refused(await attempt(new Browser(h.app), { userHandle: handle }), 'wrong_person', annaId)
    })

    it('when the answer is for a question that was not asked', async () => {
      await refused(await attempt(new Browser(h.app), { challenge: Buffer.from('a question nobody asked').toString('base64url') }), 'expired')
    })

    it('when the answer is for the question of another sign-in', async () => {
      const other = await openLogin(new Browser(h.app))
      await refused(await attempt(new Browser(h.app), { challenge: other.question.challenge }), 'expired')
    })

    it('when the question has run out', async () => {
      const browser = new Browser(h.app)
      const login = await openLogin(browser)
      await h.database.pool.query(`update passkey_challenges set expires_at = now() - interval '1 second'`)
      const response = await post(browser, `${login.interaction}/passkey`, { credential: JSON.stringify(phone.get(login.question)) })
      await refused({ browser, response, ...login }, 'expired')
    })

    it('when pforte does not know the passkey, as after it was removed', async () => {
      const other = createAuthenticator({ origin: ISSUER })
      other.create({ challenge: 'x', rp: { id: 'localhost' } })
      const browser = new Browser(h.app)
      const login = await openLogin(browser)
      const response = await post(browser, `${login.interaction}/passkey`, { credential: JSON.stringify(other.get(login.question)) })
      await refused({ browser, response, ...login }, 'unknown_passkey')
    })

    it.each([
      ['locked', `update users set status = 'locked', locked_at = now() where id = $1`],
      ['deactivated', `update users set status = 'deactivated' where id = $1`],
    ])('when the person is %s', async (_name, change) => {
      await h.database.pool.query(change, [annaId])
      await refused(await attempt(), 'not_allowed', annaId)
    })

    it.each([
      ['nothing', {}],
      ['not JSON', { credential: 'passkey' }],
      ['JSON that is no answer', { credential: '{"id":"x"}' }],
    ] satisfies [string, Record<string, string>][])('when what comes back is %s', async (_name, form) => {
      const browser = new Browser(h.app)
      const login = await openLogin(browser)
      await refused({ browser, response: await post(browser, `${login.interaction}/passkey`, form), ...login }, 'malformed')
    })

    it('when the counter of the device goes back, as with a copy of the passkey', async () => {
      await attempt(new Browser(h.app), { counter: 7 })
      await h.database.pool.query(`delete from audit_events where action like 'login.%'`)
      await h.database.pool.query(`update passkeys set last_used_at = null`)

      await refused(await attempt(new Browser(h.app), { counter: 3 }), 'verification_failed', annaId)
      expect((await passkey()).counter).toBe('7')
    })
  })

  describe('an answer is good once', () => {
    it('cannot be sent again, not in the same sign-in and not in a new one', async () => {
      const browser = new Browser(h.app)
      const login = await openLogin(browser)
      const credential = JSON.stringify(phone.get(login.question))
      const first = await post(browser, `${login.interaction}/passkey`, { credential })
      expect(first.statusCode).toBe(303)

      // Somebody who saw the answer go by sends it into a sign-in of their own.
      const thief = new Browser(h.app)
      const theirs = await openLogin(thief)
      const replayed = await post(thief, `${theirs.interaction}/passkey`, { credential })

      expect(replayed.statusCode).toBe(401)
      expect((await events('login.passkey_failed')).map((event) => event.details.reason)).toEqual(['expired'])
      expect(await events('login.succeeded')).toHaveLength(1)
    })

    it('signs in once when the same answer arrives several times at the same moment', async () => {
      const browser = new Browser(h.app)
      const login = await openLogin(browser)
      const credential = JSON.stringify(phone.get(login.question))

      const responses = await Promise.all(Array.from({ length: 5 }, () => post(browser, `${login.interaction}/passkey`, { credential })))

      expect(responses.map((response) => response.statusCode).sort()).toEqual([303, 401, 401, 401, 401])
      expect(await events('login.succeeded')).toHaveLength(1)
    })
  })

  describe('a device that counts', () => {
    it('signs in once when two sign-ins were checked against the same counter, and the counter does not go back', async () => {
      const one = new Browser(h.app)
      const two = new Browser(h.app)
      const first = await openLogin(one)
      const second = await openLogin(two)

      const responses = await Promise.all([
        post(one, `${first.interaction}/passkey`, { credential: JSON.stringify(phone.get(first.question, { counter: 5 })) }),
        post(two, `${second.interaction}/passkey`, { credential: JSON.stringify(phone.get(second.question, { counter: 6 })) }),
      ])

      expect(responses.map((response) => response.statusCode).sort()).toEqual([303, 401])
      const winner = responses[0]!.statusCode === 303 ? '5' : '6'
      expect((await passkey()).counter).toBe(winner)
      expect(await events('login.succeeded')).toHaveLength(1)
      expect((await events('login.passkey_failed')).map((event) => event.details.reason)).toEqual(['verification_failed'])
    })

    it('signs in side by side with a passkey that does not count', async () => {
      const one = new Browser(h.app)
      const two = new Browser(h.app)
      const first = await openLogin(one)
      const second = await openLogin(two)

      const responses = await Promise.all([
        post(one, `${first.interaction}/passkey`, { credential: JSON.stringify(phone.get(first.question)) }),
        post(two, `${second.interaction}/passkey`, { credential: JSON.stringify(phone.get(second.question)) }),
      ])

      expect(responses.map((response) => response.statusCode)).toEqual([303, 303])
    })
  })

  describe('too many refused passkeys from one address', () => {
    it('hold that address back, and the right passkey with it, until the wait is over', async () => {
      const ip = '203.0.113.50'
      for (let n = 0; n < 30; n++) {
        const browser = new Browser(h.app)
        const login = await openLogin(browser)
        const response = await browser.request('POST', `${login.interaction}/passkey`, { form: { credential: 'x' }, headers: { 'sec-fetch-site': 'same-origin' }, ip })
        expect(response.statusCode).toBe(401)
      }

      const browser = new Browser(h.app)
      const login = await openLogin(browser)
      const blocked = await browser.request('POST', `${login.interaction}/passkey`, { form: { credential: JSON.stringify(phone.get(login.question)) }, headers: { 'sec-fetch-site': 'same-origin' }, ip })

      expect(blocked.statusCode).toBe(429)
      expect((await events('login.blocked')).map((event) => event.details.scope)).toEqual(['passkey'])
      expect(await events('login.succeeded')).toEqual([])
      // From elsewhere the passkey works.
      expect((await attempt()).response.statusCode).toBe(303)
    })
  })

  it('is refused when the form comes from another website', async () => {
    const browser = new Browser(h.app)
    const login = await openLogin(browser)
    const response = await browser.request('POST', `${login.interaction}/passkey`, { form: { credential: JSON.stringify(phone.get(login.question)) }, headers: { 'sec-fetch-site': 'cross-site' } })
    expect(response.statusCode).toBe(403)
    expect(await events('login.succeeded')).toEqual([])
  })
})
