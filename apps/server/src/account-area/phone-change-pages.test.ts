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
const OLD = '+4915112345678'
const NEW = '+4915187654321'
const CHANGE = '/account/phone/change'
const LINK = `<br><a href="${CHANGE}">Change number</a>`
const NUMBER_FIELD = '<input id="phone" name="phone" type="tel"'
const CODE_FORM = `<form method="post" action="${CHANGE}/confirm">`

describe.skipIf(!hasDatabase)('the account pages: changing the phone number', () => {
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
    h.notifier.failWith = undefined
    await h.database.pool.query('delete from rate_limits')
    await h.database.pool.query('delete from otp_codes')
    await h.database.pool.query(`delete from audit_events where action like 'login.%' or action like 'user.phone.%' or action = 'user.update'`)
    // Both have a number they confirmed long ago, which the back office entered: their codes come by SMS.
    await h.database.pool.query(
      `update users set phone = $3, phone_verified_at = now(), phone_set_by_user_at = null, first_name = initcap(split_part(email, '.', 1)), status = 'active', language = 'en' where email in ($1, $2)`,
      [A.email, B.email, OLD],
    )
  })

  const userOf = async (email: string) =>
    (await h.database.pool.query(`select id, phone, phone_verified_at, phone_set_by_user_at, first_name from users where email = $1`, [email])).rows[0] as {
      id: string
      phone: string | null
      phone_verified_at: Date | null
      phone_set_by_user_at: Date | null
      first_name: string
    }
  const phoneCodes = () => h.notifications.filter((n) => n.kind === 'phone-code')
  const notices = () => h.notifications.filter((n) => n.kind === 'phone-changed')

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
  /** Lets the limit of one code a minute pass. */
  const aMinuteLater = async (email: string) => h.database.pool.query(`update otp_codes set created_at = created_at - interval '2 minutes' where user_id = $1`, [(await userOf(email)).id])
  /** The person asked for this number and its code is on the way. */
  const asked = async (email: string, phone = NEW) => {
    const browser = await signedIn(email)
    h.notifications.length = 0
    const sent = await post(browser, `${CHANGE}/send`, { phone })
    expect(sent.headers.location).toBe(CHANGE)
    return browser
  }

  describe('the overview', () => {
    it('offers to change the number, and says that it is the one detail that can be changed here', async () => {
      const page = await (await signedIn(A.email)).request('GET', '/account')

      expect(page.body).toContain(`•78${LINK}</dd>`)
      expect(page.body).toContain('only the mobile number can be changed here.')
      expect(page.body).not.toContain(OLD)
    })

    it('offers it next to the offer to confirm a number that is not confirmed', async () => {
      await h.database.pool.query(`update users set phone_verified_at = null where email = $1`, [A.email])

      const page = await (await signedIn(A.email)).request('GET', '/account')

      expect(page.body).toContain(`Confirm with a code by SMS</button></form>${LINK}</dd>`)
    })

    it('offers somebody without a number to add one', async () => {
      await h.database.pool.query(`update users set phone = null, phone_verified_at = null where email = $1`, [A.email])

      const page = await (await signedIn(A.email)).request('GET', '/account')

      expect(page.body).toContain(`None stored<br><a href="${CHANGE}">Add a number</a></dd>`)
    })

    it('offers nothing where this pforte sends no SMS, and the addresses behind the link do nothing', async () => {
      const browser = await signedIn(A.email)
      h.notifier.smsAvailable = false
      h.notifications.length = 0

      const page = await browser.request('GET', '/account')

      expect(page.body).not.toContain('/account/phone')
      expect(page.body).toContain('it cannot be changed here.')
      expect((await browser.request('GET', CHANGE)).headers.location).toBe('/account')
      expect((await post(browser, `${CHANGE}/send`, { phone: NEW })).headers.location).toBe('/account')
      expect((await post(browser, `${CHANGE}/confirm`, { code: '123456' })).headers.location).toBe('/account')
      expect(h.notifications).toEqual([])
      expect((await userOf(A.email)).phone).toBe(OLD)
    })
  })

  describe('asking for a number', () => {
    it('shows the field for the number to somebody who has just signed in', async () => {
      const page = await (await signedIn(A.email)).request('GET', CHANGE)

      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('<h1>Change your mobile number</h1>')
      expect(page.body).toContain(NUMBER_FIELD)
      expect(page.body).not.toContain(CODE_FORM)
      expect(page.body).toContain('<a href="/account" aria-current="page">')
      expect(page.headers['cache-control']).toBe('no-store')
    })

    it('asks for a new sign-in before the number is typed when the last one is older than five minutes', async () => {
      const browser = await signedIn(A.email)
      age(browser, 301)

      const page = await browser.request('GET', CHANGE)

      expect(page.headers.location).toBe(`/account/login?again=1&next=${encodeURIComponent(CHANGE)}`)
      const { response, visited } = await driveSignIn(h, browser, page.headers.location as string, A.email)
      expect(visited.at(-1)).toBe(CHANGE)
      expect(response.body).toContain(NUMBER_FIELD)
    })

    it('sends a code by SMS to the new number, and changes nothing yet', async () => {
      const browser = await signedIn(A.email)
      h.notifications.length = 0

      const sent = await post(browser, `${CHANGE}/send`, { phone: NEW })

      expect(sent.statusCode).toBe(303)
      expect(sent.headers.location).toBe(CHANGE)
      expect(h.notifications.map((n) => [n.kind, n.user.email, n.user.phone, n.channel])).toEqual([['phone-code', A.email, NEW, 'sms']])
      const page = await follow(browser, sent)
      expect(page.body).toContain('A new code is on its way.')
      // The number is named in full here: the person has just typed it, and this is where a slip is seen.
      expect(page.body).toContain(`We sent a 6-digit code by SMS to ${NEW}.`)
      expect(page.body).toContain(CODE_FORM)
      expect(page.body).toContain(`<input type="hidden" name="phone" value="${NEW}">`)
      expect(page.body).toContain(`<a class="button secondary" href="${CHANGE}?other=1">Use another number</a>`)
      expect(page.body).not.toContain(NUMBER_FIELD)
      const user = await userOf(A.email)
      expect(user).toMatchObject({ phone: OLD, phone_set_by_user_at: null })
      expect(user.phone_verified_at).toBeInstanceOf(Date)
      expect((await h.audit('login.code_sent', user.id)).at(-1)!.details).toMatchObject({ purpose: 'phone_change', channel: 'sms' })
      expect(await h.audit('user.phone.change', user.id)).toEqual([])
    })

    it.each(['+49 151 87654321', '0049-151-876 543 21', '+49 (151) 876.54321'])('takes the number as people write it: %s', async (typed) => {
      const browser = await signedIn(A.email)

      await post(browser, `${CHANGE}/send`, { phone: typed })

      expect(phoneCodes().map((n) => n.user.phone)).toEqual([NEW])
    })

    it.each([
      ['a number without its country code', '0151 87654321'],
      ['something that is no number', 'my new phone'],
      ['a number that is too long', '+4915187654321000000'],
      ['nothing', ''],
    ])('refuses %s, says what is expected and sends nothing', async (_name, typed) => {
      const browser = await signedIn(A.email)
      h.notifications.length = 0

      const refused = await post(browser, `${CHANGE}/send`, { phone: typed })

      expect(refused.headers.location).toBe(`${CHANGE}?other=1`)
      const page = await follow(browser, refused)
      expect(page.body).toContain('<p class="flash error" role="alert">That is not a mobile number with its country code.')
      expect(page.body).toContain(NUMBER_FIELD)
      expect(h.notifications).toEqual([])
      expect(await h.database.pool.query(`select 1 from otp_codes where purpose = 'phone_change'`)).toMatchObject({ rowCount: 0 })
    })

    it('refuses the number the person has and has confirmed', async () => {
      const browser = await signedIn(A.email)
      h.notifications.length = 0

      const refused = await post(browser, `${CHANGE}/send`, { phone: OLD })

      expect((await follow(browser, refused)).body).toContain('That is the number you have already.')
      expect(h.notifications).toEqual([])
    })

    it('asks for a new sign-in when the last one is older than five minutes, and sends nothing before', async () => {
      const browser = await signedIn(A.email)
      h.notifications.length = 0
      age(browser, 301)

      const sent = await post(browser, `${CHANGE}/send`, { phone: NEW })

      expect(sent.headers.location).toBe(`/account/login?again=1&next=${encodeURIComponent(CHANGE)}`)
      expect(h.notifications).toEqual([])
    })

    it('does not send a second code right away, and still asks for the first', async () => {
      const browser = await asked(A.email)

      const again = await post(browser, `${CHANGE}/send`, { phone: '+4915100000001' })

      expect(again.headers.location).toBe(CHANGE)
      const page = await follow(browser, again)
      expect(page.body).toMatch(/Please wait (\d+ seconds|1 minute) before asking for another code\./)
      expect(page.body).toContain(`by SMS to ${NEW}.`)
      expect(phoneCodes().map((n) => n.user.phone)).toEqual([NEW])
    })

    it('sends a new code to the same number, and the first one is worth nothing then', async () => {
      const browser = await asked(A.email)
      const first = h.lastPhoneCode(A.email)!
      await aMinuteLater(A.email)

      await post(browser, `${CHANGE}/send`, { phone: NEW })

      const second = h.lastPhoneCode(A.email)!
      expect(phoneCodes()).toHaveLength(2)
      if (first !== second) expect((await post(browser, `${CHANGE}/confirm`, { code: first })).headers.location).toBe(CHANGE)
      expect((await post(browser, `${CHANGE}/confirm`, { code: second })).headers.location).toBe('/account')
      expect((await userOf(A.email)).phone).toBe(NEW)
    })

    it('lets the person take another number while a code is on its way', async () => {
      const browser = await asked(A.email)

      const page = await browser.request('GET', `${CHANGE}?other=1`)

      expect(page.body).toContain(NUMBER_FIELD)
      expect(page.body).not.toContain(CODE_FORM)
    })

    it('says so when the SMS cannot be sent, and asks for the number again', async () => {
      const browser = await signedIn(A.email)
      h.notifier.failSms = true

      const sent = await post(browser, `${CHANGE}/send`, { phone: NEW })

      expect(sent.headers.location).toBe(CHANGE)
      const page = await follow(browser, sent)
      expect(page.body).toContain('<p class="flash error" role="alert">The code could not be sent. Please try again later.</p>')
      expect(page.body).toContain(NUMBER_FIELD)
      expect(page.body).not.toContain(CODE_FORM)
      expect((await userOf(A.email)).phone).toBe(OLD)
    })

    it('holds back somebody who asks for code after code from one address', async () => {
      const browser = await signedIn(A.email)
      for (let request = 0; request < 10; request++) await h.limiter.codeResend('127.0.0.1')
      h.notifications.length = 0

      const held = await post(browser, `${CHANGE}/send`, { phone: NEW })

      expect(held.statusCode).toBe(429)
      expect(h.notifications).toEqual([])
    })
  })

  describe('entering the code', () => {
    it('makes the number the person’s: stored, confirmed, recorded as their own doing, and told to them by mail', async () => {
      const browser = await asked(A.email)

      const done = await post(browser, `${CHANGE}/confirm`, { code: h.lastPhoneCode(A.email)! })

      expect(done.headers.location).toBe('/account')
      const overview = await follow(browser, done)
      expect(overview.body).toContain('<p class="flash ok" role="status">Your mobile number was changed. Your sign-in codes now come to it by SMS.</p>')
      expect(overview.body).toContain(`•21${LINK}</dd>`)
      const user = await userOf(A.email)
      expect(user.phone).toBe(NEW)
      expect(user.phone_verified_at).toBeInstanceOf(Date)
      expect(user.phone_set_by_user_at).toBeInstanceOf(Date)
      expect((await h.audit('user.phone.change', user.id)).at(-1)).toMatchObject({
        actor_type: 'user',
        actor_id: user.id,
        details: { email: A.email, self: true, changes: { phone: { from: OLD, to: NEW } } },
      })
      expect(await userOf(B.email)).toMatchObject({ phone: OLD, phone_set_by_user_at: null })

      // The notice goes to the mailbox, names the number only in part and leads to the account pages.
      await h.settle()
      expect(notices().map((n) => [n.user.email, n.channel, n.phone, n.url])).toEqual([[A.email, 'email', '+49•••••••••21', expect.stringMatching(/\/account$/)]])

      // The page for the code has nothing left to ask for.
      expect((await browser.request('GET', CHANGE)).body).toContain(NUMBER_FIELD)

      h.notifications.length = 0
      await signedIn(A.email)
      expect(h.notifications.filter((n) => n.kind === 'login-code').map((n) => [n.channel, n.user.phone])).toEqual([['sms', NEW]])
    })

    it('gives somebody their first number', async () => {
      await h.database.pool.query(`update users set phone = null, phone_verified_at = null where email = $1`, [A.email])
      const browser = await asked(A.email)

      await post(browser, `${CHANGE}/confirm`, { code: h.lastPhoneCode(A.email)! })

      const user = await userOf(A.email)
      expect(user.phone).toBe(NEW)
      expect(user.phone_verified_at).toBeInstanceOf(Date)
      expect((await h.audit('user.phone.change', user.id)).at(-1)!.details).toMatchObject({ changes: { phone: { from: null, to: NEW } } })
    })

    it('takes a number that is stored but not confirmed: the code confirms it, and it is the person’s then', async () => {
      await h.database.pool.query(`update users set phone_verified_at = null where email = $1`, [A.email])
      const browser = await asked(A.email, OLD)

      await post(browser, `${CHANGE}/confirm`, { code: h.lastPhoneCode(A.email)! })

      const user = await userOf(A.email)
      expect(user.phone).toBe(OLD)
      expect(user.phone_verified_at).toBeInstanceOf(Date)
      expect(user.phone_set_by_user_at).toBeInstanceOf(Date)
    })

    it('accepts the code with a space in it, and does not ask for a new sign-in: the person may have waited for the SMS', async () => {
      const browser = await asked(A.email)
      const code = h.lastPhoneCode(A.email)!
      age(browser, 301)

      const done = await post(browser, `${CHANGE}/confirm`, { code: `${code.slice(0, 3)} ${code.slice(3)}` })

      expect(done.headers.location).toBe('/account')
      expect((await userOf(A.email)).phone).toBe(NEW)
    })

    it('still shows the field for the code after five minutes, without a new sign-in', async () => {
      const browser = await asked(A.email)
      age(browser, 301)

      const page = await browser.request('GET', CHANGE)

      expect(page.statusCode).toBe(200)
      expect(page.body).toContain(CODE_FORM)
    })

    it.each([
      ['a wrong code', '000000'],
      ['something that is no code', 'abc'],
      ['nothing', ''],
    ])('refuses %s, says so, records it and changes nothing', async (_name, code) => {
      const browser = await asked(A.email)
      const wrong = code === h.lastPhoneCode(A.email) ? '111111' : code

      const refused = await post(browser, `${CHANGE}/confirm`, { code: wrong })

      expect(refused.headers.location).toBe(CHANGE)
      expect((await follow(browser, refused)).body).toContain('The code is not correct or has expired.')
      const user = await userOf(A.email)
      expect(user).toMatchObject({ phone: OLD, phone_set_by_user_at: null })
      expect((await h.audit('login.code_failed', user.id)).at(-1)!.details).toMatchObject({ purpose: 'phone_change' })
      expect(await h.audit('user.phone.change', user.id)).toEqual([])
      await h.settle()
      expect(notices()).toEqual([])
    })

    it('makes no other number the person’s than the one the code went to, whatever the browser says', async () => {
      const browser = await asked(A.email)
      const other = '+4915100000001'
      // The cookie of somebody who could sign cookies: it names another number than the code was sent to.
      browser.cookies.set('pforte_account_phone', sign(COOKIE_KEYS, { userId: (await userOf(A.email)).id, phone: other, expiresAt: Date.now() + 60_000 }))

      const refused = await post(browser, `${CHANGE}/confirm`, { code: h.lastPhoneCode(A.email)!, phone: other })

      expect(refused.headers.location).toBe(CHANGE)
      expect((await userOf(A.email)).phone).toBe(OLD)
    })

    it('does not take a number from a cookie that pforte did not sign, or from the form', async () => {
      const browser = await asked(A.email)
      const code = h.lastPhoneCode(A.email)!
      const cookie = browser.cookies.get('pforte_account_phone')!
      browser.cookies.set('pforte_account_phone', `${cookie.split('.')[0]}.${'x'.repeat(43)}`)

      const refused = await post(browser, `${CHANGE}/confirm`, { code, phone: NEW })

      expect(refused.headers.location).toBe(CHANGE)
      expect((await userOf(A.email)).phone).toBe(OLD)
    })

    it('does not take the code of somebody else, also not in the browser that asked for it', async () => {
      const anna = await asked(A.email)
      const code = h.lastPhoneCode(A.email)!
      const ben = await signedIn(B.email)
      // Ben at Anna's browser: her cookie with the number is there, his session is.
      ben.cookies.set('pforte_account_phone', anna.cookies.get('pforte_account_phone')!)

      const refused = await post(ben, `${CHANGE}/confirm`, { code })

      expect(refused.headers.location).toBe(CHANGE)
      expect((await userOf(B.email)).phone).toBe(OLD)
      expect((await userOf(A.email)).phone).toBe(OLD)
      expect((await ben.request('GET', CHANGE)).body).not.toContain(NEW)
    })

    it('does nothing without a sign-in, and is refused from another site', async () => {
      const browser = await asked(A.email)
      const code = h.lastPhoneCode(A.email)!

      expect((await post(new Browser(h.app), `${CHANGE}/confirm`, { code })).headers.location).toBe('/account/login')
      expect((await browser.request('POST', `${CHANGE}/confirm`, { form: { code }, headers: { 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403)
      expect((await userOf(A.email)).phone).toBe(OLD)
    })

    it('offers the field for the number again once the code has no attempts left', async () => {
      const browser = await asked(A.email)
      const code = h.lastPhoneCode(A.email)!
      const wrong = code === '000000' ? '111111' : '000000'
      for (let attempt = 0; attempt < 5; attempt++) await post(browser, `${CHANGE}/confirm`, { code: wrong })

      const page = await browser.request('GET', CHANGE)

      expect(page.body).toContain(NUMBER_FIELD)
      expect(page.body).not.toContain(CODE_FORM)
      expect((await post(browser, `${CHANGE}/confirm`, { code })).headers.location).toBe(CHANGE)
      expect((await userOf(A.email)).phone).toBe(OLD)
    })

    it('ends a code that was out to confirm the number the person had', async () => {
      await h.database.pool.query(`update users set phone_verified_at = null where email = $1`, [A.email])
      const browser = await signedIn(A.email)
      await post(browser, '/account/phone/send')
      const forOld = h.lastPhoneCode(A.email)!
      await post(browser, `${CHANGE}/send`, { phone: NEW })
      await post(browser, `${CHANGE}/confirm`, { code: h.lastPhoneCode(A.email)! })
      const { id, phone_verified_at: confirmedAt } = await userOf(A.email)

      // Nothing is left to confirm, and the code that went to the old number is no longer one.
      expect((await post(browser, '/account/phone/confirm', { code: forOld })).headers.location).toBe('/account')
      expect(await h.database.pool.query(`select 1 from otp_codes where user_id = $1 and purpose = 'activation' and expires_at > now() and consumed_at is null`, [id])).toMatchObject({ rowCount: 0 })
      expect(await userOf(A.email)).toMatchObject({ phone: NEW, phone_verified_at: confirmedAt })
    })

    it('changes the number although the notice cannot be sent', async () => {
      const browser = await asked(A.email)
      const code = h.lastPhoneCode(A.email)!
      h.notifier.failWith = new (await import('../notifications/notifier.js')).NotifierUnavailableError('mail is down')

      const done = await post(browser, `${CHANGE}/confirm`, { code })

      expect(done.headers.location).toBe('/account')
      await h.settle()
      expect(h.backgroundErrors).toEqual([])
      expect((await userOf(A.email)).phone).toBe(NEW)
    })
  })

  describe('the number is the person’s from then on', () => {
    const changed = async () => {
      const browser = await asked(A.email)
      await post(browser, `${CHANGE}/confirm`, { code: h.lastPhoneCode(A.email)! })
      const user = await userOf(A.email)
      expect(user.phone).toBe(NEW)
      return user
    }
    const upsert = (body: Record<string, unknown>, query = '') => h.api('PUT', `/users/by-email/${encodeURIComponent(A.email)}${query}`, { token: h.directoryToken, body })

    it('a sync that still has the old number leaves it alone, and says that nothing changed', async () => {
      const { first_name: firstName, phone_verified_at: confirmedAt } = await changed()

      const synced = await upsert({ firstName, lastName: 'Schmidt', phone: OLD })

      expect(synced.statusCode, synced.body).toBe(200)
      expect(synced.json()).toMatchObject({ outcome: 'unchanged', user: { phone: NEW, phoneSetByUserAt: expect.any(String) } })
      expect(await userOf(A.email)).toMatchObject({ phone: NEW, phone_verified_at: confirmedAt })
    })

    it('a sync that names no number at all, or removes it, leaves it alone as well', async () => {
      const { first_name: firstName } = await changed()

      expect((await upsert({ firstName, lastName: 'Schmidt' })).json()).toMatchObject({ outcome: 'unchanged' })
      expect((await upsert({ firstName, lastName: 'Schmidt', phone: null })).json()).toMatchObject({ outcome: 'unchanged' })

      expect((await userOf(A.email)).phone).toBe(NEW)
    })

    it('a sync still changes everything else, and a dry run says the same as the real call', async () => {
      await changed()

      const dry = await upsert({ firstName: 'Annabel', lastName: 'Schmidt', phone: OLD }, '?dryRun=true')
      const real = await upsert({ firstName: 'Annabel', lastName: 'Schmidt', phone: OLD })

      expect(dry.json()).toEqual({ dryRun: true, outcome: 'updated', changes: { profile: { firstName: { from: 'Anna', to: 'Annabel' } }, claims: {} } })
      expect(real.json()).toMatchObject({ outcome: 'updated', user: { firstName: 'Annabel', phone: NEW } })
      const user = await userOf(A.email)
      expect(user).toMatchObject({ phone: NEW, first_name: 'Annabel' })
      expect(user.phone_verified_at).toBeInstanceOf(Date)
    })

    it('a sync still sets the number of somebody who never chose one', async () => {
      await changed()

      const synced = await h.api('PUT', `/users/by-email/${encodeURIComponent(B.email)}`, { token: h.directoryToken, body: { firstName: 'Ben', lastName: 'Keller', phone: NEW } })

      expect(synced.json()).toMatchObject({ outcome: 'updated', user: { phone: NEW, phoneVerifiedAt: null, phoneSetByUserAt: null } })
    })

    it('an administrator can still correct it: it is not confirmed then, and it stays the person’s', async () => {
      const { id } = await changed()
      const other = '+4915100000001'

      const corrected = await h.api('PATCH', `/users/${id}`, { body: { phone: other } })

      expect(corrected.statusCode, corrected.body).toBe(200)
      expect(corrected.json()).toMatchObject({ phone: other, phoneVerifiedAt: null, phoneSetByUserAt: expect.any(String) })
      // and the source does not put its own back afterwards
      expect((await upsert({ firstName: 'Anna', lastName: 'Schmidt', phone: OLD })).json()).toMatchObject({ outcome: 'unchanged', user: { phone: other } })
    })
  })
})
