import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sign, unsign } from './signed-cookie.js'
import { type AdminHarness, createAdminHarness, ISSUER } from '../test/admin-harness.js'
import { type AnswerOptions, createAuthenticator, type CreationQuestion } from '../test/authenticator.js'
import { Browser } from '../test/browser.js'
import { endSessionsDuring } from '../test/held-user.js'
import { driveSignIn } from '../test/manage-session.js'
import { openLogin, post, questionIn, tokensAfter } from '../test/passkey-flows.js'

const COOKIE_KEYS = ['k'.repeat(40)]
const A = { email: 'anna.schmidt@example.com' }
const B = { email: 'ben.keller@example.com' }
const DAY = 24 * 60 * 60 * 1000

describe.skipIf(!hasDatabase)('the offer of a passkey after a sign-in with a code', () => {
  let h: AdminHarness
  let annaId: string
  const phone = createAuthenticator({ origin: ISSUER })

  beforeAll(async () => {
    h = await createAdminHarness()
    annaId = (await h.database.pool.query(`select id from users where email = $1`, [A.email])).rows[0].id
    await h.database.pool.query(`update users set language = 'en' where email in ($1, $2)`, [A.email, B.email])
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(async () => {
    await h.settle()
    h.notifications.length = 0
    await h.database.pool.query('delete from rate_limits')
    await h.database.pool.query('delete from otp_codes')
    await h.database.pool.query('delete from passkeys')
    await h.database.pool.query('delete from passkey_challenges')
    await h.database.pool.query('delete from passkey_offers')
    await h.database.pool.query('delete from devices')
    await h.database.pool.query(`delete from audit_events where action like 'login.%' or action like 'user.passkey.%'`)
    await h.database.pool.query(`delete from oidc_payloads where account_id is not null`)
    await h.database.pool.query(`update users set status = 'active', locked_at = null where email in ($1, $2)`, [A.email, B.email])
  })

  const passkeysOf = async (email: string) => (await h.database.pool.query(`select p.* from passkeys p join users u on u.id = p.user_id where u.email = $1`, [email])).rows
  const mails = () => h.notifications.filter((notification) => notification.kind === 'passkey-added')
  const codeFor = (email: string) => h.notifications.findLast((notification) => notification.kind === 'login-code' && notification.user.email === email)!.code!

  /**
   * Password, then the code, in this browser. `capable` is what the script of the code page writes into the form
   * when the device can make a passkey; without the script the field stays empty.
   */
  const signInWithCode = async (browser: Browser, email: string, { capable = true, remember = false, again = false } = {}) => {
    // `again`: the browser is signed in at pforte already, and the application asks for a new sign-in.
    const login = await openLogin(browser, again ? { extra: { prompt: 'login' } } : {})
    const password = await post(browser, `${login.interaction}/login`, { email, password: 'dev-password' })
    expect(password.headers.location).toBe(`${login.interaction}/code`)
    const codePage = await browser.request('GET', `${login.interaction}/code`)
    const afterCode = await post(browser, `${login.interaction}/code`, { code: codeFor(email), passkeys: capable ? '1' : '', ...(remember ? { remember: 'on' } : {}) })
    return { ...login, codePage, afterCode, offer: `${login.interaction}/passkey-offer` }
  }
  /** Follows the sign-in to the offer and returns its page with what it asks the device. */
  const offered = async (browser: Browser, email: string) => {
    const flow = await signInWithCode(browser, email)
    expect(flow.afterCode.statusCode).toBe(303)
    expect(flow.afterCode.headers.location).toBe(flow.offer)
    const page = await browser.request('GET', flow.offer)
    expect(page.statusCode, page.body).toBe(200)
    return { ...flow, browser, page, question: questionIn<CreationQuestion>(page.body, 'create') }
  }

  describe('the code page', () => {
    it('asks the script whether the device can make a passkey, and runs nothing else', async () => {
      const { codePage } = await signInWithCode(new Browser(h.app), A.email)

      expect(codePage.body).toContain('<input type="hidden" name="passkeys" value="" data-passkey-capable>')
      expect(codePage.headers['content-security-policy']).toBe(h.passkeys.script.policy)
      expect(codePage.body.match(/<script/g)).toHaveLength(1)
    })
  })

  describe('whether it is shown', () => {
    it('is shown to somebody whose device can make a passkey, between the code and the application', async () => {
      const browser = new Browser(h.app)
      const { page } = await offered(browser, A.email)

      expect(page.body).toContain('<h1>Sign in faster next time</h1>')
      expect(page.body).toContain('<button type="submit" disabled>Create passkey</button>')
      expect(page.body).toContain('<button type="submit" class="secondary">Not now</button>')
      expect(page.headers['content-security-policy']).toBe(h.passkeys.script.policy)
      // The sign-in itself is done and recorded; only the way back waits.
      expect((await h.database.pool.query(`select count(*) from audit_events where action = 'login.succeeded'`)).rows[0].count).toBe('1')
    })

    it('is not shown without the script, or on a device that cannot: the sign-in ends as before', async () => {
      const browser = new Browser(h.app)
      const { afterCode, verifier } = await signInWithCode(browser, A.email, { capable: false })

      const { claims } = await tokensAfter(browser, afterCode, verifier)
      expect(claims).toMatchObject({ sub: annaId, acr: 'urn:pforte:acr:mfa', amr: ['pwd', 'otp'] })
      expect(browser.cookies.has('pforte_passkey_step')).toBe(false)
    })

    it('is not shown after a sign-in on a remembered device, which entered no code', async () => {
      const browser = new Browser(h.app)
      const first = await signInWithCode(browser, A.email, { capable: false, remember: true })
      await tokensAfter(browser, first.afterCode, first.verifier)
      for (const name of browser.cookies.keys()) if (name !== 'pforte_device') browser.cookies.delete(name)

      const login = await openLogin(browser)
      const password = await post(browser, `${login.interaction}/login`, { email: A.email, password: 'dev-password' })

      // Straight back to the application: no code page, so no offer.
      const { claims } = await tokensAfter(browser, password, login.verifier)
      expect(claims.acr).toBe('urn:pforte:acr:pwd')
    })
  })

  describe('"Not now"', () => {
    it('ends the sign-in as the code had, and is remembered in this browser for 90 days', async () => {
      const browser = new Browser(h.app)
      const { offer, verifier } = await offered(browser, A.email)

      const skipped = await post(browser, `${offer}/skip`)

      const { claims } = await tokensAfter(browser, skipped, verifier)
      expect(claims).toMatchObject({ sub: annaId, acr: 'urn:pforte:acr:mfa', amr: ['pwd', 'otp'] })
      expect(await passkeysOf(A.email)).toEqual([])
      const answers = unsign<{ people: Record<string, number> }>(COOKIE_KEYS, browser.cookies.get('pforte_passkey_offer'))!
      const [until] = Object.values(answers.people)
      expect(until! * 1000 - Date.now()).toBeGreaterThan(89 * DAY)
      expect(until! * 1000 - Date.now()).toBeLessThanOrEqual(90 * DAY)
      // The cookie names nobody.
      expect(JSON.stringify(answers)).not.toContain(annaId)

      // The next sign-in with a code in this browser goes straight on.
      const next = await signInWithCode(browser, A.email, { again: true })
      expect(next.afterCode.headers.location).not.toBe(next.offer)
      await tokensAfter(browser, next.afterCode, next.verifier)
    })

    it('comes back after 90 days', async () => {
      const browser = new Browser(h.app)
      const { offer } = await offered(browser, A.email)
      await post(browser, `${offer}/skip`)
      const answers = unsign<{ purpose: string; people: Record<string, number> }>(COOKIE_KEYS, browser.cookies.get('pforte_passkey_offer'))!
      const aged = Object.fromEntries(Object.entries(answers.people).map(([person]) => [person, Math.floor(Date.now() / 1000) - 1]))
      browser.cookies.set('pforte_passkey_offer', sign(COOKIE_KEYS, { ...answers, people: aged }))

      const next = await signInWithCode(browser, A.email)
      expect(next.afterCode.headers.location).toBe(next.offer)
    })

    it("is one person's answer: somebody else at the same browser gets their own offer", async () => {
      const browser = new Browser(h.app)
      const { offer, verifier } = await offered(browser, A.email)
      await tokensAfter(browser, await post(browser, `${offer}/skip`), verifier)
      for (const name of browser.cookies.keys()) if (name !== 'pforte_passkey_offer') browser.cookies.delete(name)

      const ben = await signInWithCode(browser, B.email)
      expect(ben.afterCode.headers.location).toBe(ben.offer)
      // And Ben's answer does not undo Anna's.
      await post(browser, `${ben.offer}/skip`)
      expect(Object.keys(unsign<{ people: object }>(COOKIE_KEYS, browser.cookies.get('pforte_passkey_offer'))!.people)).toHaveLength(2)
    })
  })

  describe('creating one', () => {
    it('stores the passkey, tells the person by e-mail, ends the sign-in and does not ask again', async () => {
      const browser = new Browser(h.app)
      const { offer, question, verifier } = await offered(browser, A.email)

      const created = await post(browser, offer, { credential: JSON.stringify(phone.create(question)) })

      const { claims } = await tokensAfter(browser, created, verifier)
      // The sign-in is the one with the code: the passkey was made, not used.
      expect(claims).toMatchObject({ sub: annaId, acr: 'urn:pforte:acr:mfa', amr: ['pwd', 'otp'] })
      expect(await passkeysOf(A.email)).toMatchObject([{ label: 'Safari, iPhone' }])
      const [event] = await h.audit('user.passkey.add', annaId)
      expect(event).toMatchObject({ actor_type: 'user', actor_id: annaId })
      expect(event.details).toMatchObject({ self: true })
      await h.settle()
      expect(mails()).toMatchObject([{ device: 'Safari, iPhone', url: `${ISSUER}/account/passkeys` }])
      expect(browser.cookies.has('pforte_passkey_step')).toBe(false)

      const next = await signInWithCode(browser, A.email, { again: true })
      expect(next.afterCode.headers.location).not.toBe(next.offer)
    })

    it('lets the passkey sign in the next time, which keeps the browser from being asked', async () => {
      const browser = new Browser(h.app)
      const { offer, question, verifier } = await offered(browser, A.email)
      await tokensAfter(browser, await post(browser, offer, { credential: JSON.stringify(phone.create(question)) }), verifier)

      const fresh = new Browser(h.app)
      const login = await openLogin(fresh)
      const signedIn = await post(fresh, `${login.interaction}/passkey`, { credential: JSON.stringify(phone.get(login.question)) })

      expect((await tokensAfter(fresh, signedIn, login.verifier)).claims).toMatchObject({ sub: annaId, amr: ['pop', 'mfa'] })
      const answers = unsign<{ people: Record<string, number> }>(COOKIE_KEYS, fresh.cookies.get('pforte_passkey_offer'))!
      expect(Object.values(answers.people)[0]! * 1000 - Date.now()).toBeGreaterThan(399 * DAY)
    })

    it.each([
      ['made on a page of another origin', { origin: 'https://localhost.example.com' }],
      ['made without the device checking the person', { userVerified: false }],
      ['made for a question that was not asked', { challenge: Buffer.from('never asked').toString('base64url') }],
    ] satisfies [string, AnswerOptions][])('shows the offer again when the answer was %s, and the person can still go on', async (_name, answer) => {
      const browser = new Browser(h.app)
      const { offer, question, verifier } = await offered(browser, A.email)

      const refused = await post(browser, offer, { credential: JSON.stringify(phone.create(question, answer)) })

      expect(refused.statusCode).toBe(422)
      expect(refused.body).toContain('No passkey was created. You can try again, or go on without one.')
      expect(await passkeysOf(A.email)).toEqual([])
      // A new question is in the page, and it works.
      const again = await post(browser, offer, { credential: JSON.stringify(phone.create(questionIn<CreationQuestion>(refused.body, 'create'))) })
      await tokensAfter(browser, again, verifier)
      expect(await passkeysOf(A.email)).toHaveLength(1)
    })

    it('takes an answer once', async () => {
      const browser = new Browser(h.app)
      const { offer, question } = await offered(browser, A.email)
      const credential = JSON.stringify(phone.create(question))

      const responses = await Promise.all(Array.from({ length: 4 }, () => post(browser, offer, { credential })))

      // One makes the passkey and goes on to the application. The others find the question used up, or the offer over.
      expect(responses.filter((response) => String(response.headers.location).includes('/auth/'))).toHaveLength(1)
      expect(await passkeysOf(A.email)).toHaveLength(1)
    })
  })

  describe('the sign-in that waits behind it', () => {
    it('cannot be had with the cookie of the step between password and code', async () => {
      // Somebody who knows the password, and nothing else, has that cookie. It is signed with the same keys.
      const browser = new Browser(h.app)
      const login = await openLogin(browser)
      await post(browser, `${login.interaction}/login`, { email: A.email, password: 'dev-password' })
      browser.cookies.set('pforte_passkey_step', browser.cookies.get('pforte_second_factor')!)

      for (const response of [await browser.request('GET', `${login.interaction}/passkey-offer`), await post(browser, `${login.interaction}/passkey-offer/skip`), await post(browser, `${login.interaction}/passkey-offer`, { credential: '{}' })]) {
        expect(response.statusCode).toBe(303)
        expect(response.headers.location).toBe(login.interaction)
      }
      expect((await h.database.pool.query(`select count(*) from oidc_payloads where account_id = $1 and type = 1`, [annaId])).rows[0].count).toBe('0')
      expect(await passkeysOf(A.email)).toEqual([])
    })

    it('belongs to its own sign-in: its cookie does nothing in another one', async () => {
      const browser = new Browser(h.app)
      const first = await offered(browser, A.email)
      const waiting = browser.cookies.get('pforte_passkey_step')!
      const other = new Browser(h.app)
      const login = await openLogin(other)
      other.cookies.set('pforte_passkey_step', waiting)

      const skipped = await post(other, `${login.interaction}/passkey-offer/skip`)

      expect(skipped.headers.location).toBe(login.interaction)
      expect(first.offer).not.toBe(`${login.interaction}/passkey-offer`)
    })

    it('is kept at pforte: the browser holds a token that says nothing, and pforte does not keep the token', async () => {
      const browser = new Browser(h.app)
      await offered(browser, A.email)

      const token = browser.cookies.get('pforte_passkey_step')!
      expect(token).toMatch(/^[\w-]{43}$/)
      const { rows } = await h.database.pool.query(`select * from passkey_offers`)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ user_id: annaId, details: { acr: 'urn:pforte:acr:mfa', amr: ['pwd', 'otp'], language: 'en' } })
      expect(JSON.stringify(rows)).not.toContain(token)
    })

    it('runs out after a quarter of an hour', async () => {
      const browser = new Browser(h.app)
      const { offer, interaction } = await offered(browser, A.email)
      const { rows } = await h.database.pool.query(`select expires_at from passkey_offers`)
      expect(rows[0].expires_at.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000)
      expect(rows[0].expires_at.getTime() - Date.now()).toBeGreaterThan(14 * 60_000)
      await h.database.pool.query(`update passkey_offers set expires_at = now() - interval '1 second'`)

      expect((await post(browser, `${offer}/skip`)).headers.location).toBe(interaction)
    })

    describe('ends with the sessions of the person', () => {
      /** Somebody else's browser, in which the person is signed in to their account pages. */
      const accountOf = async (email: string) => {
        const account = new Browser(h.app)
        await driveSignIn(h, account, '/account', email)
        return account
      }

      it.each([
        ['an administrator signs them out everywhere', () => h.api('POST', `/users/${annaId}/end-sessions`)],
        ['an administrator starts a password reset for them', () => h.api('POST', `/users/${annaId}/reset-password`)],
        ['they sign themselves out everywhere, on their account pages', async () => post(await accountOf(A.email), '/account/sessions/end')],
      ])('when %s: it finishes no sign-in and makes no passkey any more', async (_name, end) => {
        const browser = new Browser(h.app)
        const { offer, interaction, question } = await offered(browser, A.email)
        const sessionsBefore = (await h.database.pool.query(`select count(*) from oidc_payloads where account_id = $1 and type = 1`, [annaId])).rows[0].count

        const ended = await end()
        expect(ended.statusCode).toBeLessThan(400)

        // What was begun before cannot be finished after: not with "not now", not with a passkey, not by looking.
        expect((await browser.request('GET', offer)).headers.location).toBe(interaction)
        expect((await post(browser, offer, { credential: JSON.stringify(phone.create(question)) })).headers.location).toBe(interaction)
        expect((await post(browser, `${offer}/skip`)).headers.location).toBe(interaction)
        expect(await passkeysOf(A.email)).toEqual([])
        expect(Number((await h.database.pool.query(`select count(*) from oidc_payloads where account_id = $1 and type = 1`, [annaId])).rows[0].count)).toBeLessThanOrEqual(Number(sessionsBefore))
        // The login page is what is left, and it asks for everything again.
        expect((await browser.request('GET', interaction)).body).toContain('name="password"')
      })
    })

    it('is opened together with the acceptance of the code, behind the ending of sessions that got there first', async () => {
      const browser = new Browser(h.app)
      const login = await openLogin(browser)
      await post(browser, `${login.interaction}/login`, { email: A.email, password: 'dev-password' })
      const code = codeFor(A.email)
      const codes = async () => (await h.database.pool.query(`select consumed_at from otp_codes where user_id = $1 and purpose = 'login'`, [annaId])).rows
      const offers = async () => (await h.database.pool.query(`select count(*) from passkey_offers where user_id = $1`, [annaId])).rows[0].count

      // The sessions are being ended when the code arrives. The request waits: it has neither used the code up
      // nor opened an offer. There is no state in between for the ending of the sessions to miss.
      const afterCode = await endSessionsDuring(
        h,
        annaId,
        () => post(browser, `${login.interaction}/code`, { code, passkeys: '1' }),
        async () => {
          expect(await codes()).toEqual([{ consumed_at: null }])
          expect(await offers()).toBe('0')
        },
      )

      // Then both happen, after the sessions were ended: a code entered now is a sign-in of now.
      expect(afterCode.headers.location).toBe(`${login.interaction}/passkey-offer`)
      expect((await codes())[0].consumed_at).not.toBeNull()
      expect(await offers()).toBe('1')
      // And what ends the sessions from here on finds the offer.
      await h.api('POST', `/users/${annaId}/end-sessions`)
      expect(await offers()).toBe('0')
      expect((await post(browser, `${login.interaction}/passkey-offer/skip`)).headers.location).toBe(login.interaction)
    })

    it('stores no passkey when the sessions are ended while the answer of the device is being checked', async () => {
      const browser = new Browser(h.app)
      const { offer, interaction, question } = await offered(browser, A.email)
      const credential = JSON.stringify(phone.create(question))

      // The request finds the offer open, uses up its question and checks the answer. Then, before it stores
      // the passkey, the sessions are ended.
      const response = await endSessionsDuring(h, annaId, () => post(browser, offer, { credential }))

      expect(response.statusCode).toBe(303)
      expect(response.headers.location).toBe(interaction)
      expect(await passkeysOf(A.email)).toEqual([])
      expect(await h.audit('user.passkey.add', annaId)).toEqual([])
      await h.settle()
      expect(mails()).toEqual([])
      expect((await h.database.pool.query(`select count(*) from oidc_payloads where account_id = $1 and type = 1`, [annaId])).rows[0].count).toBe('0')
      // It was the answer to the real question: without the ending of the sessions it makes a passkey.
      const again = await offered(new Browser(h.app), A.email)
      expect((await post(again.browser, again.offer, { credential: JSON.stringify(phone.create(again.question)) })).headers.location).toContain('/auth/')
    })

    it('finishes one sign-in, once: a copy of its token is worth nothing after the answer', async () => {
      const browser = new Browser(h.app)
      const { offer, interaction, question, verifier } = await offered(browser, A.email)
      const token = browser.cookies.get('pforte_passkey_step')!
      await tokensAfter(browser, await post(browser, `${offer}/skip`), verifier)

      browser.cookies.set('pforte_passkey_step', token)

      expect((await browser.request('GET', offer)).statusCode).not.toBe(200)
      await post(browser, offer, { credential: JSON.stringify(phone.create(question)) })
      expect(await passkeysOf(A.email)).toEqual([])
      expect(interaction).toBeTruthy()
    })

    it('finishes once when "Not now" arrives several times at the same moment', async () => {
      const browser = new Browser(h.app)
      const { offer, interaction } = await offered(browser, A.email)

      const responses = await Promise.all(Array.from({ length: 5 }, () => post(browser, `${offer}/skip`)))

      const finished = responses.filter((response) => response.headers.location !== interaction)
      expect(finished).toHaveLength(1)
      expect(String(finished[0]!.headers.location)).toContain('/auth/')
    })

    it('is not finished for somebody who was locked meanwhile', async () => {
      const browser = new Browser(h.app)
      const { offer, interaction, question } = await offered(browser, A.email)
      await h.database.pool.query(`update users set status = 'locked', locked_at = now() where id = $1`, [annaId])

      expect((await post(browser, `${offer}/skip`)).headers.location).toBe(interaction)
      expect((await post(browser, offer, { credential: JSON.stringify(phone.create(question)) })).headers.location).toBe(interaction)
      expect(await passkeysOf(A.email)).toEqual([])
    })

    it('is finished without an offer for somebody who has as many passkeys as an account may have', async () => {
      await h.database.pool.query(`insert into passkeys (user_id, credential_id, public_key) select $1, 'filler-' || n, 'key' from generate_series(1, 20) n`, [annaId])
      const browser = new Browser(h.app)
      const flow = await signInWithCode(browser, A.email)
      expect(flow.afterCode.headers.location).toBe(flow.offer)

      const page = await browser.request('GET', flow.offer)

      await tokensAfter(browser, page, flow.verifier)
    })
  })
})
