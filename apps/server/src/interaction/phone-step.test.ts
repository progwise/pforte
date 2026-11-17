import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type AdminHarness, createAdminHarness, ISSUER } from '../test/admin-harness.js'
import { createAuthenticator } from '../test/authenticator.js'
import { Browser } from '../test/browser.js'
import { enrol, openLogin, post, tokensAfter } from '../test/passkey-flows.js'

/** Two people of the seed. Anna's number is not confirmed; Ben's is. */
const A = { email: 'anna.schmidt@example.com' }
const B = { email: 'ben.keller@example.com' }
const NUMBER = '+4915112345678'
const OTHER_NUMBER = '+4915187654321'
const DAY = 24 * 60 * 60 * 1000
const TITLE = '<h1>Confirm your phone number</h1>'
const WHY = 'Your phone number +49•••••••••78 is not confirmed yet, so your sign-in codes come by e-mail.'
const CODE_FIELD = 'name="code"'

describe.skipIf(!hasDatabase)('confirming the phone number at a sign-in', () => {
  let h: AdminHarness
  let annaId: string

  beforeAll(async () => {
    h = await createAdminHarness()
    annaId = (await h.database.pool.query(`select id from users where email = $1`, [A.email])).rows[0].id
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(async () => {
    await h.settle()
    h.notifications.length = 0
    h.notifier.smsAvailable = true
    h.notifier.failSms = false
    await h.database.pool.query('delete from rate_limits')
    await h.database.pool.query('delete from otp_codes')
    await h.database.pool.query('delete from passkeys')
    await h.database.pool.query('delete from passkey_challenges')
    await h.database.pool.query('delete from passkey_offers')
    await h.database.pool.query('delete from devices')
    await h.database.pool.query(`delete from audit_events where action like 'login.%' or action like 'user.phone.%'`)
    await h.database.pool.query(`delete from oidc_payloads where account_id is not null`)
    await h.database.pool.query(`update users set phone = $2, phone_verified_at = null, status = 'active', locked_at = null, language = 'en' where email = $1`, [A.email, NUMBER])
    await h.database.pool.query(`update users set phone = $2, phone_verified_at = now(), status = 'active', language = 'en' where email = $1`, [B.email, NUMBER.replace('78', '79')])
  })

  const confirmed = async () => (await h.database.pool.query(`select phone_verified_at from users where id = $1`, [annaId])).rows[0].phone_verified_at !== null
  const phoneCodes = () => h.notifications.filter((n) => n.kind === 'phone-code')
  const loginCode = (email: string) => h.notifications.findLast((n) => n.kind === 'login-code' && n.user.email === email)!
  const sessionsOf = async (userId: string) => (await h.database.pool.query(`select count(*) from oidc_payloads where account_id = $1 and type = 1`, [userId])).rows[0].count as string
  const audited = async (action: string) => (await h.database.pool.query(`select details from audit_events where action = $1 order by created_at`, [action])).rows.map((row) => row.details)

  /** Password, then the code, in this browser. Returns where the sign-in went after the code. */
  const signIn = async (browser: Browser, email: string, { capable = false, remember = false, again = false } = {}) => {
    const login = await openLogin(browser, again ? { extra: { prompt: 'login' } } : {})
    const password = await post(browser, `${login.interaction}/login`, { email, password: 'dev-password' })
    // A browser that is remembered is not asked for the code.
    const after = password.headers.location === `${login.interaction}/code` ? await post(browser, `${login.interaction}/code`, { code: loginCode(email).code!, passkeys: capable ? '1' : '', ...(remember ? { remember: 'on' } : {}) }) : password
    expect(after.statusCode, after.body).toBe(303)
    return { ...login, after, phone: `${login.interaction}/phone`, offer: `${login.interaction}/passkey-offer` }
  }
  /** Signs in as far as the phone step and returns its page. */
  const asked = async (browser = new Browser(h.app), options: Parameters<typeof signIn>[2] = {}) => {
    const flow = await signIn(browser, A.email, options)
    expect(flow.after.headers.location).toBe(flow.phone)
    const page = await browser.request('GET', flow.phone)
    expect(page.statusCode, page.body).toBe(200)
    return { ...flow, browser, page }
  }
  /** Whether a finished sign-in leads back to the application, and what the application then learns. */
  const arrived = async (browser: Browser, finished: { statusCode: number; headers: Record<string, unknown> }, verifier: string) => {
    expect(String(finished.headers.location)).toMatch(/\/auth\/[\w-]+$/)
    return (await tokensAfter(browser, finished, verifier)).claims
  }

  describe('who is asked', () => {
    it('asks somebody whose number is not confirmed, after the code and before the application, and sends nothing by itself', async () => {
      const { page, phone } = await asked()

      expect(page.body).toContain(TITLE)
      expect(page.body).toContain(WHY)
      expect(page.body).not.toContain(NUMBER)
      expect(page.body).toContain(`<form method="post" action="${phone}/send">\n<button type="submit">Confirm with a code by SMS</button>`)
      expect(page.body).toContain(`<form method="post" action="${phone}/skip">\n<button type="submit" class="secondary">Not now</button>`)
      expect(page.body).not.toContain(CODE_FIELD)
      // The code of the sign-in came by e-mail, and no SMS went out: a message costs money, so the person asks for it.
      expect(loginCode(A.email).channel).toBe('email')
      expect(phoneCodes()).toHaveLength(0)
      // Signed in as far as pforte's log goes; the application has not heard of it yet.
      expect(await audited('login.succeeded')).toHaveLength(1)
      expect(await sessionsOf(annaId)).toBe('0')
    })

    it('does not ask somebody whose number is confirmed, who has none, or where no SMS is sent', async () => {
      const ben = new Browser(h.app)
      const confirmedNumber = await signIn(ben, B.email)
      await arrived(ben, confirmedNumber.after, confirmedNumber.verifier)

      await h.database.pool.query(`update users set phone = null where id = $1`, [annaId])
      const none = new Browser(h.app)
      const noNumber = await signIn(none, A.email)
      await arrived(none, noNumber.after, noNumber.verifier)

      await h.database.pool.query(`update users set phone = $2 where id = $1`, [annaId, NUMBER])
      h.notifier.smsAvailable = false
      h.notifications.length = 0
      await h.database.pool.query('delete from otp_codes')
      const off = new Browser(h.app)
      const noSms = await signIn(off, A.email)
      await arrived(off, noSms.after, noSms.verifier)
    })

    it('asks after a sign-in with a remembered device, which needs no code', async () => {
      const browser = new Browser(h.app)
      await h.database.pool.query(`update users set phone_verified_at = now() where id = $1`, [annaId])
      const first = await signIn(browser, A.email, { remember: true })
      await arrived(browser, first.after, first.verifier)

      // The back office changes the number: the confirmation is gone with it.
      await h.api('PATCH', `/users/${annaId}`, { body: { phone: OTHER_NUMBER } })
      h.notifications.length = 0
      const second = await signIn(browser, A.email, { again: true })
      expect(h.notifications.filter((n) => n.kind === 'login-code')).toHaveLength(0)
      expect(second.after.headers.location).toBe(second.phone)
      expect((await browser.request('GET', second.phone)).body).toContain('+49•••••••••21')

      // "Not now" ends the sign-in as the remembered device had ended it.
      const claims = await arrived(browser, await post(browser, `${second.phone}/skip`), second.verifier)
      expect(claims.amr).toEqual(['pwd'])
    })

    it('asks after a sign-in with a passkey', async () => {
      const device = createAuthenticator({ origin: ISSUER })
      await h.database.pool.query(`update users set phone_verified_at = now() where id = $1`, [annaId])
      await enrol(h, device, A.email)
      await h.database.pool.query(`update users set phone_verified_at = null where id = $1`, [annaId])

      const browser = new Browser(h.app)
      const login = await openLogin(browser)
      const signedIn = await post(browser, `${login.interaction}/passkey`, { credential: JSON.stringify(device.get(login.question)) })
      expect(signedIn.statusCode, signedIn.body).toBe(303)
      expect(signedIn.headers.location).toBe(`${login.interaction}/phone`)
      expect((await browser.request('GET', `${login.interaction}/phone`)).body).toContain(WHY)

      const claims = await arrived(browser, await post(browser, `${login.interaction}/phone/skip`), login.verifier)
      expect(claims.amr).toEqual(['pop', 'mfa'])
    })
  })

  describe('confirming', () => {
    it('sends the code when asked, confirms the number with it and goes on to the application', async () => {
      const { browser, phone, verifier } = await asked()

      const sent = await post(browser, `${phone}/send`)
      expect(sent.statusCode, sent.body).toBe(200)
      expect(sent.body).toContain('Enter the 6-digit code from the SMS.')
      expect(sent.body).toContain(CODE_FIELD)
      expect(sent.body).toContain(`<form method="post" action="${phone}/confirm">`)
      // With the field the page names no number: the code went to the number of the moment it was sent.
      expect(sent.body).not.toContain('•78')
      expect(phoneCodes()).toHaveLength(1)
      expect(phoneCodes()[0]!.user.email).toBe(A.email)

      const done = await post(browser, `${phone}/confirm`, { code: h.lastPhoneCode(A.email)! })
      await arrived(browser, done, verifier)
      expect(await confirmed()).toBe(true)
      expect(await audited('login.code_sent')).toContainEqual(expect.objectContaining({ purpose: 'activation', channel: 'sms' }))
      expect(await audited('user.phone.confirm')).toHaveLength(1)

      // From the next sign-in on the code comes by SMS, and nothing is asked.
      h.notifications.length = 0
      await h.database.pool.query('delete from otp_codes')
      const next = new Browser(h.app)
      const again = await signIn(next, A.email)
      expect(loginCode(A.email).channel).toBe('sms')
      await arrived(next, again.after, again.verifier)
    })

    it('shows the field again to somebody who comes back to the page while a code is on its way', async () => {
      const { browser, phone } = await asked()
      await post(browser, `${phone}/send`)

      const page = await browser.request('GET', phone)
      expect(page.body).toContain(CODE_FIELD)
      expect(page.body).toContain('Send a new code')
    })

    it('refuses a wrong code, counts it, and leaves the sign-in waiting', async () => {
      const { browser, phone, verifier } = await asked()
      await post(browser, `${phone}/send`)
      const right = h.lastPhoneCode(A.email)!

      const wrong = await post(browser, `${phone}/confirm`, { code: right === '000000' ? '000001' : '000000' })
      expect(wrong.statusCode).toBe(401)
      expect(wrong.body).toContain('The code is not correct or has expired.')
      expect(wrong.body).toContain(CODE_FIELD)
      expect(await confirmed()).toBe(false)
      expect(await audited('login.code_failed')).toContainEqual(expect.objectContaining({ purpose: 'activation', reason: 'wrong' }))
      expect(await sessionsOf(annaId)).toBe('0')

      await arrived(browser, await post(browser, `${phone}/confirm`, { code: right }), verifier)
      expect(await confirmed()).toBe(true)
    })

    it('does not confirm a number the back office changed while the code was on its way', async () => {
      const { browser, phone, verifier } = await asked()
      await post(browser, `${phone}/send`)
      const code = h.lastPhoneCode(A.email)!
      await h.api('PATCH', `/users/${annaId}`, { body: { phone: OTHER_NUMBER } })

      const refused = await post(browser, `${phone}/confirm`, { code })
      expect(refused.statusCode).toBe(401)
      expect(await confirmed()).toBe(false)

      // The sign-in is still there to be finished.
      await arrived(browser, await post(browser, `${phone}/skip`), verifier)
    })

    it('goes on when the number was confirmed elsewhere meanwhile', async () => {
      const { browser, phone, verifier } = await asked()
      await h.database.pool.query(`update users set phone_verified_at = now() where id = $1`, [annaId])

      await arrived(browser, await browser.request('GET', phone), verifier)
    })

    it('sends one code a minute, and says so', async () => {
      const { browser, phone } = await asked()
      await post(browser, `${phone}/send`)

      const second = await post(browser, `${phone}/send`)
      expect(second.statusCode).toBe(429)
      expect(Number(second.headers['retry-after'])).toBeGreaterThan(0)
      expect(second.body).toMatch(/You can ask for a new one in \d+ seconds/)
      expect(second.body).toContain(CODE_FIELD)
      expect(phoneCodes()).toHaveLength(1)
    })

    it('offers to send again when the SMS could not be sent, instead of asking for a code nobody got', async () => {
      const { browser, phone, verifier } = await asked()
      h.notifier.failSms = true

      const failed = await post(browser, `${phone}/send`)
      expect(failed.statusCode).toBe(503)
      expect(failed.body).toContain('The code could not be sent. Please try again later.')
      expect(failed.body).not.toContain(CODE_FIELD)
      expect(failed.body).toContain('Confirm with a code by SMS')

      await arrived(browser, await post(browser, `${phone}/skip`), verifier)
    })
  })

  describe('"not now"', () => {
    it('goes on to the application and leaves the number unconfirmed', async () => {
      const { browser, phone, verifier } = await asked()

      const claims = await arrived(browser, await post(browser, `${phone}/skip`), verifier)
      expect(claims.amr).toEqual(['pwd', 'otp'])
      expect(await confirmed()).toBe(false)
      expect(phoneCodes()).toHaveLength(0)
    })

    it('is remembered in that browser for 30 days, for that person and that number', async () => {
      const { browser, phone, verifier } = await asked()
      const skipped = await post(browser, `${phone}/skip`)
      const cookie = [skipped.headers['set-cookie']].flat().find((header) => String(header).startsWith('pforte_phone_later='))
      expect(cookie).toMatch(/; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Strict/)
      expect(cookie).not.toContain(annaId)
      await arrived(browser, skipped, verifier)

      // The next sign-in in that browser goes straight on.
      h.notifications.length = 0
      await h.database.pool.query('delete from otp_codes')
      const quiet = await signIn(browser, A.email, { again: true })
      await arrived(browser, quiet.after, quiet.verifier)

      // Another browser has not heard the answer.
      h.notifications.length = 0
      await h.database.pool.query('delete from otp_codes')
      const elsewhere = await signIn(new Browser(h.app), A.email)
      expect(elsewhere.after.headers.location).toBe(elsewhere.phone)

      // A new number is a new question, also in the browser that said "not now" about the old one.
      await h.api('PATCH', `/users/${annaId}`, { body: { phone: OTHER_NUMBER } })
      h.notifications.length = 0
      await h.database.pool.query('delete from otp_codes')
      const changed = await signIn(browser, A.email, { again: true })
      expect(changed.after.headers.location).toBe(changed.phone)
    })

    it('asks again when the 30 days are over', async () => {
      const { browser, phone, verifier } = await asked()
      await arrived(browser, await post(browser, `${phone}/skip`), verifier)
      const answer = browser.cookies.get('pforte_phone_later')!

      const reminder = (await import('./phone-reminder.js')).createPhoneReminder({ cookieKeys: ['k'.repeat(40)], secure: true })
      const user = { id: annaId, phone: NUMBER }
      expect(reminder.due(`pforte_phone_later=${answer}`, user)).toBe(false)
      expect(reminder.due(`pforte_phone_later=${answer}`, user, Date.now() + 29 * DAY)).toBe(false)
      expect(reminder.due(`pforte_phone_later=${answer}`, user, Date.now() + 31 * DAY)).toBe(true)
      expect(reminder.due(`pforte_phone_later=${answer}`, { id: annaId, phone: OTHER_NUMBER })).toBe(true)
      expect(reminder.due(undefined, user)).toBe(true)
    })
  })

  describe('together with the offer of a passkey', () => {
    it('asks about the phone first and offers the passkey after, whatever the answer was', async () => {
      const { browser, phone, offer, verifier } = await asked(new Browser(h.app), { capable: true })

      // The offer is not open yet: the question before it has no answer.
      const early = await browser.request('GET', offer)
      expect(early.statusCode).toBe(303)
      expect(early.headers.location).not.toBe(offer)

      const skipped = await post(browser, `${phone}/skip`)
      expect(skipped.statusCode).toBe(303)
      expect(skipped.headers.location).toBe(offer)
      expect(await sessionsOf(annaId)).toBe('0')
      const offered = await browser.request('GET', offer)
      expect(offered.statusCode, offered.body).toBe(200)
      expect(offered.body).toContain('Sign in faster next time')
      // The phone step is over for this sign-in.
      expect((await browser.request('GET', phone)).statusCode).toBe(303)

      const claims = await arrived(browser, await post(browser, `${offer}/skip`), verifier)
      expect(claims.amr).toEqual(['pwd', 'otp'])
    })

    it('goes on to the offer after the number was confirmed', async () => {
      const { browser, phone, offer } = await asked(new Browser(h.app), { capable: true })
      await post(browser, `${phone}/send`)

      const done = await post(browser, `${phone}/confirm`, { code: h.lastPhoneCode(A.email)! })
      expect(done.statusCode).toBe(303)
      expect(done.headers.location).toBe(offer)
      expect(await confirmed()).toBe(true)
    })

    it('offers no passkey where the device cannot make one', async () => {
      const { browser, offer } = await asked()

      const page = await browser.request('GET', offer)
      expect(page.statusCode).toBe(303)
      expect(page.headers.location).not.toBe(offer)
      expect((await post(browser, offer, { credential: '{}' })).statusCode).toBe(303)
      expect(await sessionsOf(annaId)).toBe('0')
    })
  })

  describe('a sign-in that waits at the phone step', () => {
    it.each([
      ['"not now"', (browser: Browser, phone: string) => post(browser, `${phone}/skip`)],
      ['the page', (browser: Browser, phone: string) => browser.request('GET', phone)],
      ['asking for a code', (browser: Browser, phone: string) => post(browser, `${phone}/send`)],
    ])('is over when the sessions of the person are ended: %s leads back to the start', async (_name, go) => {
      const { browser, phone, interaction } = await asked()
      expect((await h.api('POST', `/users/${annaId}/end-sessions`)).statusCode).toBe(200)

      const response = await go(browser, phone)
      expect(response.statusCode).toBe(303)
      expect(response.headers.location).toBe(interaction)
      expect(await sessionsOf(annaId)).toBe('0')
      expect(phoneCodes()).toHaveLength(0)
    })

    it('is finished once: a second answer finds nothing', async () => {
      const { browser, phone, interaction, verifier } = await asked()
      const copy = new Browser(h.app)
      for (const [name, value] of browser.cookies) copy.cookies.set(name, value)

      const first = await post(browser, `${phone}/skip`)
      // The same answer once more, from a copy of everything the browser holds, before the first is followed.
      const second = await post(copy, `${phone}/skip`)
      expect(second.statusCode).toBe(303)
      expect(second.headers.location).toBe(interaction)

      await arrived(browser, first, verifier)
      expect(await sessionsOf(annaId)).toBe('1')
    })

    it('belongs to the browser it was completed in', async () => {
      const { phone } = await asked()

      const stranger = new Browser(h.app)
      for (const response of [await stranger.request('GET', phone), await post(stranger, `${phone}/skip`), await post(stranger, `${phone}/send`)]) {
        expect([303, 400]).toContain(response.statusCode)
        expect(String(response.headers.location ?? '')).not.toMatch(/\/auth\//)
      }
      expect(phoneCodes()).toHaveLength(0)
    })
  })
})
