import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sign, unsign } from '../interaction/signed-cookie.js'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { Browser } from '../test/browser.js'
import { driveSignIn } from '../test/manage-session.js'

const COOKIE_KEYS = ['k'.repeat(40)]
/** Two people of the seed. Whatever one of them does must never be the other's. */
const A = { email: 'anna.schmidt@example.com' }
const B = { email: 'ben.keller@example.com' }
const NUMBER = '+4915112345678'
const NOTE = 'Not confirmed, so your sign-in codes come by e-mail.'
const BUTTON = '<form method="post" action="/account/phone/send"><button type="submit" class="secondary">Confirm with a code by SMS</button></form>'
/** What the page for the code offers while no code is on its way. */
const FIRST_SEND = '<form method="post" action="/account/phone/send"><button type="submit">Confirm with a code by SMS</button></form>'

describe.skipIf(!hasDatabase)('the account pages: confirming the phone number', () => {
  let h: AdminHarness

  beforeAll(async () => {
    h = await createAdminHarness()
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(async () => {
    await h.settle()
    h.notifications.length = 0
    h.notifier.smsAvailable = true
    h.notifier.failSms = false
    h.notifier.hold = undefined
    await h.database.pool.query('delete from rate_limits')
    await h.database.pool.query('delete from otp_codes')
    await h.database.pool.query(`delete from audit_events where action like 'login.%' or action = 'user.phone.confirm'`)
    // Both have a number the back office entered and nobody has confirmed: codes come by e-mail.
    await h.database.pool.query(`update users set phone = $3, phone_verified_at = null, status = 'active', language = 'en' where email in ($1, $2)`, [A.email, B.email, NUMBER])
  })

  const userOf = async (email: string) => (await h.database.pool.query(`select id, phone_verified_at from users where email = $1`, [email])).rows[0] as { id: string; phone_verified_at: Date | null }
  const confirmed = async (email: string) => (await userOf(email)).phone_verified_at !== null
  const phoneCodes = () => h.notifications.filter((n) => n.kind === 'phone-code')

  /** A browser in which this person is signed in to their account pages, a moment ago. */
  const signedIn = async (email: string) => {
    const browser = new Browser(h.app)
    const { response } = await driveSignIn(h, browser, '/account', email)
    expect(response.statusCode, response.body).toBe(200)
    return browser
  }
  /** Makes the sign-in of this browser look as if it happened so many seconds ago. */
  const age = (browser: Browser, seconds: number) => {
    const session = unsign<{ authTime: number }>(COOKIE_KEYS, browser.cookies.get('pforte_account'))!
    browser.cookies.set('pforte_account', sign(COOKIE_KEYS, { ...session, authTime: session.authTime - seconds }))
  }
  const post = (browser: Browser, url: string, form: Record<string, string> = {}) => browser.request('POST', url, { form, headers: { 'sec-fetch-site': 'same-origin' } })
  const follow = async (browser: Browser, response: { headers: Record<string, unknown> }) => browser.request('GET', response.headers.location as string)

  describe('the overview', () => {
    it('says that the number is not confirmed, and offers to confirm it', async () => {
      const page = await (await signedIn(A.email)).request('GET', '/account')

      expect(page.body).toContain(`•78<br><span class="muted">${NOTE}</span>`)
      expect(page.body).toContain(BUTTON)
      expect(page.body).not.toContain(NUMBER)
    })

    it.each([
      ['the number is confirmed', async () => void (await h.database.pool.query(`update users set phone_verified_at = now() where email = $1`, [A.email]))],
      ['there is no number', async () => void (await h.database.pool.query(`update users set phone = null where email = $1`, [A.email]))],
      ['this pforte sends no SMS', async () => void (h.notifier.smsAvailable = false)],
    ])('offers nothing when %s', async (_name, arrange) => {
      const browser = await signedIn(A.email)
      await arrange()

      const page = await browser.request('GET', '/account')

      expect(page.body).not.toContain(NOTE)
      expect(page.body).not.toContain('/account/phone')
      // and the addresses behind the button do nothing either
      expect((await browser.request('GET', '/account/phone')).headers.location).toBe('/account')
      expect((await post(browser, '/account/phone/send')).headers.location).toBe('/account')
      expect((await post(browser, '/account/phone/confirm', { code: '123456' })).headers.location).toBe('/account')
      expect(phoneCodes()).toEqual([])
    })
  })

  describe('sending the code', () => {
    it('sends it by SMS to the person and leads to the page where it is entered', async () => {
      const browser = await signedIn(A.email)

      const sent = await post(browser, '/account/phone/send')

      expect(sent.statusCode).toBe(303)
      expect(sent.headers.location).toBe('/account/phone')
      expect(phoneCodes().map((n) => [n.user.email, n.channel])).toEqual([[A.email, 'sms']])
      const page = await follow(browser, sent)
      expect(page.body).toContain('<h1>Confirm your phone number</h1>')
      expect(page.body).toContain('A new code is on its way.')
      expect(page.body).toContain('Enter the 6-digit code from the SMS.')
      expect(page.body).not.toContain(NUMBER)
      expect(page.body).toContain('<form method="post" action="/account/phone/confirm">')
      expect(page.body).toContain('Send a new code')
      expect(page.body).not.toContain(FIRST_SEND)
      expect((await h.audit('login.code_sent', (await userOf(A.email)).id)).at(-1)!.details).toMatchObject({ purpose: 'activation', channel: 'sms' })
      expect(await confirmed(A.email)).toBe(false)
    })

    it('asks for a new sign-in when the last one is older than five minutes, and sends nothing before', async () => {
      const browser = await signedIn(A.email)
      age(browser, 301)

      const sent = await post(browser, '/account/phone/send')

      expect(sent.headers.location).toBe('/account/login?again=1&next=%2Faccount%2Fphone')
      expect(phoneCodes()).toEqual([])
    })

    it('comes back from that sign-in to a page that offers to send the code, and does not ask for one that was never sent', async () => {
      const browser = await signedIn(A.email)
      age(browser, 301)
      const sent = await post(browser, '/account/phone/send')

      const { response: page, visited } = await driveSignIn(h, browser, sent.headers.location as string, A.email)

      expect(visited.at(-1)).toBe('/account/phone')
      expect(page.body).toContain('For this you had to sign in again. Now repeat what you wanted to do.')
      expect(page.body).toContain('we send a 6-digit code to it by SMS')
      expect(page.body).toContain(FIRST_SEND)
      expect(page.body).not.toContain('/account/phone/confirm')
      expect(page.body).not.toContain('Send a new code')
      expect(phoneCodes()).toEqual([])

      // Repeating it sends the code, and now the page asks for it.
      const repeated = await follow(browser, await post(browser, '/account/phone/send'))
      expect(phoneCodes()).toHaveLength(1)
      expect(repeated.body).toContain('<form method="post" action="/account/phone/confirm">')
      expect(repeated.body).not.toContain(FIRST_SEND)
    })

    it('does not send a second code right away, and says how long to wait', async () => {
      const browser = await signedIn(A.email)
      await post(browser, '/account/phone/send')

      const again = await post(browser, '/account/phone/send')

      expect(again.headers.location).toBe('/account/phone')
      expect((await follow(browser, again)).body).toMatch(/Please wait (\d+ seconds|1 minute) before asking for another code\./)
      expect(phoneCodes()).toHaveLength(1)
    })

    it('says so when the SMS cannot be sent', async () => {
      const browser = await signedIn(A.email)
      h.notifier.failSms = true

      const sent = await post(browser, '/account/phone/send')

      expect(sent.headers.location).toBe('/account/phone')
      const page = await follow(browser, sent)
      expect(page.body).toContain('<p class="flash error" role="alert">The code could not be sent. Please try again later.</p>')
      // The page does not ask for a code that never arrived: it offers to send one.
      expect(page.body).toContain(FIRST_SEND)
      expect(page.body).not.toContain('/account/phone/confirm')
      expect(page.body).not.toContain('Send a new code')
      expect(await confirmed(A.email)).toBe(false)
    })

    it('sends it to nobody else, whatever the form carries', async () => {
      const browser = await signedIn(A.email)
      const other = await userOf(B.email)

      await post(browser, '/account/phone/send', { email: B.email, user: other.id, userId: other.id, phone: '+4915199999999' })

      expect(phoneCodes().map((n) => [n.user.email, n.user.phone])).toEqual([[A.email, NUMBER]])
    })
  })

  describe('entering the code', () => {
    it('confirms the number: it is recorded as the person’s own doing, and the next sign-in code comes by SMS', async () => {
      const browser = await signedIn(A.email)
      await post(browser, '/account/phone/send')

      const done = await post(browser, '/account/phone/confirm', { code: h.lastPhoneCode(A.email)! })

      expect(done.headers.location).toBe('/account')
      const overview = await follow(browser, done)
      expect(overview.body).toContain('<p class="flash ok" role="status">Phone number confirmed</p>')
      expect(overview.body).not.toContain(NOTE)
      expect(overview.body).not.toContain('/account/phone')
      const { id, phone_verified_at: at } = await userOf(A.email)
      expect(at).toBeInstanceOf(Date)
      expect((await h.audit('user.phone.confirm', id)).at(-1)).toMatchObject({ actor_type: 'user', actor_id: id, details: { email: A.email, self: true } })
      expect(await confirmed(B.email)).toBe(false)

      h.notifications.length = 0
      await signedIn(A.email)
      expect(h.notifications.filter((n) => n.kind === 'login-code').map((n) => n.channel)).toEqual(['sms'])
    })

    it('accepts the code with a space in it, as people type it', async () => {
      const browser = await signedIn(A.email)
      await post(browser, '/account/phone/send')
      const code = h.lastPhoneCode(A.email)!

      await post(browser, '/account/phone/confirm', { code: `${code.slice(0, 3)} ${code.slice(3)}` })

      expect(await confirmed(A.email)).toBe(true)
    })

    it('does not ask for a new sign-in: the code is newer than that, and the person may have waited for the SMS', async () => {
      const browser = await signedIn(A.email)
      await post(browser, '/account/phone/send')
      age(browser, 301)

      const done = await post(browser, '/account/phone/confirm', { code: h.lastPhoneCode(A.email)! })

      expect(done.headers.location).toBe('/account')
      expect(await confirmed(A.email)).toBe(true)
    })

    it.each([
      ['a wrong code', '000000'],
      ['something that is no code', 'abc'],
      ['nothing', ''],
    ])('refuses %s, says so and records it', async (_name, code) => {
      const browser = await signedIn(A.email)
      await post(browser, '/account/phone/send')
      const wrong = code === h.lastPhoneCode(A.email) ? '111111' : code

      const refused = await post(browser, '/account/phone/confirm', { code: wrong })

      expect(refused.headers.location).toBe('/account/phone')
      expect((await follow(browser, refused)).body).toContain('The code is not correct or has expired.')
      expect(await confirmed(A.email)).toBe(false)
      const { id } = await userOf(A.email)
      expect((await h.audit('login.code_failed', id)).at(-1)!.details).toMatchObject({ purpose: 'activation' })
      expect(await h.audit('user.phone.confirm', id)).toEqual([])
    })

    it('does not take the code of somebody else', async () => {
      const anna = await signedIn(A.email)
      const ben = await signedIn(B.email)
      await post(anna, '/account/phone/send')

      const refused = await post(ben, '/account/phone/confirm', { code: h.lastPhoneCode(A.email)! })

      expect(refused.headers.location).toBe('/account/phone')
      expect(await confirmed(B.email)).toBe(false)
      expect(await confirmed(A.email)).toBe(false)
    })

    it('does nothing without a sign-in, and is refused from another site', async () => {
      const browser = await signedIn(A.email)
      await post(browser, '/account/phone/send')
      const code = h.lastPhoneCode(A.email)!

      expect((await post(new Browser(h.app), '/account/phone/confirm', { code })).headers.location).toBe('/account/login')
      expect((await browser.request('POST', '/account/phone/confirm', { form: { code }, headers: { 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403)
      expect(await confirmed(A.email)).toBe(false)
    })

    it('does not confirm a number the back office changed while the code was being sent', async () => {
      const browser = await signedIn(A.email)
      const { id } = await userOf(A.email)
      let release = () => {}
      h.notifier.hold = new Promise<void>((resolve) => (release = resolve))

      // The code is made for the number as it is, and the SMS is on its way to it, when the number is changed.
      const sending = post(browser, '/account/phone/send')
      for (let tries = 0; tries < 100 && (await h.database.pool.query(`select 1 from otp_codes where user_id = $1 and purpose = 'activation'`, [id])).rowCount === 0; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const changed = await h.api('PATCH', `/users/${id}`, { body: { phone: '+4915187654321' } })
      expect(changed.statusCode, changed.body).toBe(200)
      release()
      await sending
      expect(phoneCodes().map((n) => n.user.phone)).toEqual([NUMBER])

      const refused = await post(browser, '/account/phone/confirm', { code: h.lastPhoneCode(A.email)! })

      expect(refused.headers.location).toBe('/account/phone')
      expect(await confirmed(A.email)).toBe(false)
      expect(await h.audit('user.phone.confirm', id)).toEqual([])
    })

    it('does not confirm a number the back office has changed since the code was sent', async () => {
      const browser = await signedIn(A.email)
      await post(browser, '/account/phone/send')
      const code = h.lastPhoneCode(A.email)!
      const { id } = await userOf(A.email)
      const changed = await h.api('PATCH', `/users/${id}`, { body: { phone: '+4915187654321' } })
      expect(changed.statusCode, changed.body).toBe(200)

      // The change ended the code that was out: the page does not ask for it, and offers one to the new number.
      const page = await browser.request('GET', '/account/phone')
      expect(page.body).not.toContain('/account/phone/confirm')
      expect(page.body).toContain('+49•••••••••21')
      expect(page.body).toContain(FIRST_SEND)

      const refused = await post(browser, '/account/phone/confirm', { code })

      expect(refused.headers.location).toBe('/account/phone')
      expect((await follow(browser, refused)).body).toContain('The code is not correct or has expired. You can ask for a new one below.')
      expect(await confirmed(A.email)).toBe(false)

      // The new code goes to the number that is stored now, and confirms it.
      await h.database.pool.query(`update otp_codes set created_at = created_at - interval '2 minutes' where user_id = $1`, [id])
      await post(browser, '/account/phone/send')
      expect(phoneCodes().at(-1)!.user.phone).toBe('+4915187654321')
      expect((await post(browser, '/account/phone/confirm', { code: h.lastPhoneCode(A.email)! })).headers.location).toBe('/account')
      expect(await confirmed(A.email)).toBe(true)
    })

    it('offers to send a code again once the one that was sent has no attempts left', async () => {
      const browser = await signedIn(A.email)
      await post(browser, '/account/phone/send')
      const code = h.lastPhoneCode(A.email)!
      const wrong = code === '000000' ? '111111' : '000000'
      for (let attempt = 0; attempt < 5; attempt++) await post(browser, '/account/phone/confirm', { code: wrong })

      const page = await browser.request('GET', '/account/phone')

      expect(page.body).toContain(FIRST_SEND)
      expect(page.body).not.toContain('/account/phone/confirm')
      expect((await post(browser, '/account/phone/confirm', { code })).headers.location).toBe('/account/phone')
      expect(await confirmed(A.email)).toBe(false)
    })
  })
})
