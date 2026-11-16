import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { unsign } from '../interaction/signed-cookie.js'
import { type AdminHarness, createAdminHarness, ISSUER } from '../test/admin-harness.js'
import { createAuthenticator, type CreationQuestion } from '../test/authenticator.js'
import { Browser } from '../test/browser.js'
import { openLogin, post, questionIn, tokensAfter } from '../test/passkey-flows.js'

const COOKIE_KEYS = ['k'.repeat(40)]
const GOOD = 'correct horse battery'
const NUMBER = '+4915112345678'

describe.skipIf(!hasDatabase)('the offer of a passkey at the end of an activation', () => {
  let h: AdminHarness
  let counter = 0
  const phone = createAuthenticator({ origin: ISSUER })

  beforeAll(async () => {
    h = await createAdminHarness()
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(async () => {
    await h.settle()
    h.notifications.length = 0
    h.notifier.smsAvailable = false
    await h.database.pool.query('delete from rate_limits')
  })

  const tokenOf = (url: string) => new URL(url).searchParams.get('token')!
  /** Somebody an administrator has invited, with the link from their mail. */
  const invited = async ({ withPhone = false, clientId }: { withPhone?: boolean; clientId?: string } = {}) => {
    const email = `passkey-offer${++counter}@example.com`
    const created = (await h.api('POST', '/users', { body: { email, firstName: 'Ada', lastName: 'Lovelace', language: 'en', ...(withPhone ? { phone: NUMBER } : {}) } })).json()
    const activate = await h.api('POST', `/users/${created.id}/activate`, { body: clientId ? { clientId } : undefined })
    expect(activate.statusCode, activate.body).toBe(200)
    const token = tokenOf(h.notifications.findLast((n) => n.kind === 'activation')!.url!)
    h.notifications.length = 0
    return { email, id: created.id as string, token }
  }
  /** Chooses the first password. `capable` is what the script of the page writes into the form on a device that can make a passkey. */
  const activate = (browser: Browser, token: string, capable = true) => post(browser, '/activate', { token, password: GOOD, confirm: GOOD, passkeys: capable ? '1' : '' })
  const passkeysOf = async (id: string) => (await h.database.pool.query(`select * from passkeys where user_id = $1`, [id])).rows
  const mails = () => h.notifications.filter((notification) => notification.kind === 'passkey-added')
  /** The offer page the activation leads to, with what it asks the device. */
  const offered = async (browser: Browser, response: { statusCode: number; headers: Record<string, unknown> }) => {
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/activate/passkey')
    const page = await browser.request('GET', '/activate/passkey')
    expect(page.statusCode, page.body).toBe(200)
    return { page, question: questionIn<CreationQuestion>(page.body, 'create') }
  }

  it('lets the activation page ask its script whether the device can make a passkey, and run nothing else', async () => {
    const user = await invited()

    const page = await new Browser(h.app).request('GET', `/activate?token=${user.token}`)

    expect(page.body).toContain('<input type="hidden" name="passkeys" value="" data-passkey-capable>')
    expect(page.headers['content-security-policy']).toBe(h.passkeys.script.policy)
    expect(page.body.match(/<script/g)).toHaveLength(1)
  })

  it('ends the activation as before without the script, or on a device that cannot make a passkey', async () => {
    const user = await invited()

    const done = await activate(new Browser(h.app), user.token, false)

    expect(done.statusCode).toBe(200)
    expect(done.body).toContain('Your account is active')
    expect(done.headers['set-cookie'] ?? '').not.toContain('pforte_activation_passkey')
  })

  it('offers a passkey to somebody who has just chosen their password on a device that can make one', async () => {
    const user = await invited()
    const browser = new Browser(h.app)

    const { page } = await offered(browser, await activate(browser, user.token))

    expect(page.body).toContain('<h1>Sign in faster next time</h1>')
    expect(page.body).toContain('<form method="post" action="/activate/passkey" data-passkey="create"')
    expect(page.body).toContain('<form method="post" action="/activate/passkey/skip">')
    expect(page.headers['content-security-policy']).toBe(h.passkeys.script.policy)
    // The account is active whatever the answer to the offer will be.
    expect((await h.database.pool.query(`select status from users where id = $1`, [user.id])).rows[0].status).toBe('active')
  })

  it('stores the passkey, tells the person, and ends on the page that leads to their application', async () => {
    const user = await invited({ clientId: 'demo-web' })
    const browser = new Browser(h.app)
    const { question } = await offered(browser, await activate(browser, user.token))

    const done = await post(browser, '/activate/passkey', { credential: JSON.stringify(phone.create(question)) })

    expect(done.statusCode).toBe(200)
    expect(done.body).toContain('Your account is active')
    expect(done.body).toContain('Demo web app')
    expect(await passkeysOf(user.id)).toMatchObject([{ label: 'Safari, iPhone' }])
    const [event] = await h.audit('user.passkey.add', user.id)
    expect(event).toMatchObject({ actor_type: 'user', actor_id: user.id })
    await h.settle()
    expect(mails()).toMatchObject([{ device: 'Safari, iPhone' }])
    expect(browser.cookies.has('pforte_activation_passkey')).toBe(false)

    // And the passkey signs in: the first sign-in after an activation needs no password and no code.
    const fresh = new Browser(h.app)
    const login = await openLogin(fresh)
    const { claims } = await tokensAfter(fresh, await post(fresh, `${login.interaction}/passkey`, { credential: JSON.stringify(phone.get(login.question)) }), login.verifier)
    expect(claims).toMatchObject({ sub: user.id, amr: ['pop', 'mfa'] })
    expect(h.notifications.filter((notification) => notification.kind === 'login-code')).toEqual([])
  })

  it('"Not now" ends the activation without a passkey and is remembered for the sign-ins of this browser', async () => {
    const user = await invited()
    const browser = new Browser(h.app)
    await offered(browser, await activate(browser, user.token))

    const done = await post(browser, '/activate/passkey/skip')

    expect(done.body).toContain('Your account is active')
    expect(await passkeysOf(user.id)).toEqual([])
    const header = [done.headers['set-cookie']].flat().find((cookie) => cookie?.startsWith('pforte_passkey_offer='))!
    // One cookie for the sign-in pages and for the activation: each must be sent what the other wrote.
    expect(header).toContain('Path=/;')
    expect(Object.keys(unsign<{ people: object }>(COOKIE_KEYS, header.split(';')[0]!.split('=')[1])!.people)).toHaveLength(1)
  })

  it('keeps the answers other people gave in this browser when it notes this one', async () => {
    // Anna signed in here with a code and said "not now". The test browser sends cookies by their path, as a real one does.
    const browser = new Browser(h.app)
    await h.database.pool.query(`update users set language = 'en' where email = 'anna.schmidt@example.com'`)
    const login = await openLogin(browser)
    await post(browser, `${login.interaction}/login`, { email: 'anna.schmidt@example.com', password: 'dev-password' })
    const code = h.notifications.findLast((notification) => notification.kind === 'login-code')!.code!
    const afterCode = await post(browser, `${login.interaction}/code`, { code, passkeys: '1' })
    await post(browser, `${afterCode.headers.location as string}/skip`)
    const annas = Object.keys(unsign<{ people: object }>(COOKIE_KEYS, browser.cookies.get('pforte_passkey_offer'))!.people)
    expect(annas).toHaveLength(1)

    // Somebody new activates their account in the same browser and says "not now" as well.
    const user = await invited()
    await offered(browser, await activate(browser, user.token))
    await post(browser, '/activate/passkey/skip')

    const both = Object.keys(unsign<{ people: object }>(COOKIE_KEYS, browser.cookies.get('pforte_passkey_offer'))!.people)
    expect(both).toHaveLength(2)
    expect(both).toContain(annas[0])
  })

  it('shows the offer again when the answer of the device does not hold, and the person can still go on', async () => {
    const user = await invited()
    const browser = new Browser(h.app)
    const { question } = await offered(browser, await activate(browser, user.token))

    const refused = await post(browser, '/activate/passkey', { credential: JSON.stringify(phone.create(question, { origin: 'https://localhost.example.com' })) })

    expect(refused.statusCode).toBe(422)
    expect(refused.body).toContain('No passkey was created. You can try again, or go on without one.')
    expect(await passkeysOf(user.id)).toEqual([])
    expect((await post(browser, '/activate/passkey/skip')).body).toContain('Your account is active')
  })

  it('takes an answer once', async () => {
    const user = await invited()
    const browser = new Browser(h.app)
    const { question } = await offered(browser, await activate(browser, user.token))
    const credential = JSON.stringify(phone.create(question))
    await post(browser, '/activate/passkey', { credential })
    await h.database.pool.query('delete from passkeys where user_id = $1', [user.id])

    // The step is over; and a copy of its cookie does not bring the answer back either.
    expect((await post(browser, '/activate/passkey', { credential })).body).toContain('Your account is active')
    expect(await passkeysOf(user.id)).toEqual([])
  })

  describe('the step', () => {
    it('is handed out by an activation only: without it the pages say that the account is active and do nothing', async () => {
      const user = await invited()
      await activate(new Browser(h.app), user.token, false)
      const stranger = new Browser(h.app)

      for (const response of [await stranger.request('GET', '/activate/passkey'), await post(stranger, '/activate/passkey', { credential: '{}' }), await post(stranger, '/activate/passkey/skip')]) {
        expect(response.statusCode).toBe(200)
        expect(response.body).not.toContain('data-passkey')
      }
      expect(await passkeysOf(user.id)).toEqual([])
    })

    it('cannot be had with another cookie of pforte that names a person', async () => {
      // The step of confirming a phone number is signed with the same keys and names the person.
      h.notifier.smsAvailable = true
      const user = await invited({ withPhone: true })
      const browser = new Browser(h.app)
      const withPhone = await activate(browser, user.token, false)
      expect(withPhone.body).toContain('Confirm your phone number')
      browser.cookies.set('pforte_activation_passkey', browser.cookies.get('pforte_phone_step')!)

      const page = await browser.request('GET', '/activate/passkey')

      expect(page.body).not.toContain('data-passkey')
    })

    it('is kept at pforte: the browser holds a token that says nothing', async () => {
      const user = await invited({ clientId: 'demo-web' })
      const browser = new Browser(h.app)
      await offered(browser, await activate(browser, user.token))

      const token = browser.cookies.get('pforte_activation_passkey')!
      expect(token).toMatch(/^[\w-]{43}$/)
      const { rows } = await h.database.pool.query(`select * from passkey_offers where user_id = $1`, [user.id])
      expect(rows).toMatchObject([{ bound_to: 'activation', details: { clientId: 'demo-web', done: 'account' } }])
      expect(JSON.stringify(rows)).not.toContain(token)
    })

    it('runs out after a quarter of an hour, and is no use for somebody who was locked', async () => {
      const user = await invited()
      const browser = new Browser(h.app)
      const { question } = await offered(browser, await activate(browser, user.token))
      const { rows } = await h.database.pool.query(`select expires_at from passkey_offers where user_id = $1`, [user.id])
      expect(rows[0].expires_at.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000)

      // Locking ends the offer with the person's sessions; and were it still there, a locked person gets nothing from it.
      await h.database.pool.query(`update users set status = 'locked', locked_at = now() where id = $1`, [user.id])
      await post(browser, '/activate/passkey', { credential: JSON.stringify(phone.create(question)) })
      expect(await passkeysOf(user.id)).toEqual([])

      await h.database.pool.query(`update users set status = 'active', locked_at = null where id = $1`, [user.id])
      await h.database.pool.query(`update passkey_offers set expires_at = now() - interval '1 second' where user_id = $1`, [user.id])
      expect((await browser.request('GET', '/activate/passkey')).body).not.toContain('data-passkey')
    })

    it.each([
      ['an administrator signs the person out everywhere', (id: string) => h.api('POST', `/users/${id}/end-sessions`)],
      ['an administrator starts a password reset for them', (id: string) => h.api('POST', `/users/${id}/reset-password`)],
      ['an administrator locks them', (id: string) => h.api('POST', `/users/${id}/lock`)],
    ])('ends when %s: no passkey can be made with it any more', async (_name, end) => {
      const user = await invited()
      const browser = new Browser(h.app)
      const { question } = await offered(browser, await activate(browser, user.token))

      expect((await end(user.id)).statusCode).toBeLessThan(400)

      expect((await browser.request('GET', '/activate/passkey')).body).not.toContain('data-passkey')
      const answer = await post(browser, '/activate/passkey', { credential: JSON.stringify(phone.create(question)) })
      expect(answer.body).not.toContain('data-passkey')
      expect(await passkeysOf(user.id)).toEqual([])
    })

    it.each([
      ['"Not now"', async (browser: Browser) => post(browser, '/activate/passkey/skip')],
      ['a passkey was made', async (browser: Browser, question: CreationQuestion) => post(browser, '/activate/passkey', { credential: JSON.stringify(phone.create(question)) })],
    ])('is over after %s: a copy of its token asks no device and makes no passkey', async (_name, answer) => {
      const user = await invited()
      const browser = new Browser(h.app)
      const { question } = await offered(browser, await activate(browser, user.token))
      const token = browser.cookies.get('pforte_activation_passkey')!
      await answer(browser, question)
      const made = (await passkeysOf(user.id)).length
      const questions = async () => (await h.database.pool.query(`select count(*) from passkey_challenges where user_id = $1`, [user.id])).rows[0].count
      const asked = await questions()

      browser.cookies.set('pforte_activation_passkey', token)

      const page = await browser.request('GET', '/activate/passkey')
      expect(page.body).not.toContain('data-passkey')
      expect(page.body).toContain('Your account is active')
      // No new question was handed out.
      expect(await questions()).toBe(asked)
      await post(browser, '/activate/passkey', { credential: JSON.stringify(phone.create({ ...question, challenge: 'x' })) })
      expect(await passkeysOf(user.id)).toHaveLength(made)
    })

    it('takes its question from its own person only', async () => {
      const one = await invited()
      const other = await invited()
      const first = new Browser(h.app)
      const second = new Browser(h.app)
      const { question } = await offered(first, await activate(first, one.token))
      await offered(second, await activate(second, other.token))

      const refused = await post(second, '/activate/passkey', { credential: JSON.stringify(phone.create(question)) })

      expect(refused.statusCode).toBe(422)
      expect(await passkeysOf(other.id)).toEqual([])
      expect(await passkeysOf(one.id)).toEqual([])
    })
  })

  it('sends the mail without a link where there are no account pages to link to', async () => {
    const plain = await createAdminHarness({ accountPages: false })
    try {
      const created = (await plain.api('POST', '/users', { body: { email: 'no-account-pages@example.com', firstName: 'Ada', lastName: 'Lovelace', language: 'en' } })).json()
      await plain.api('POST', `/users/${created.id}/activate`)
      const token = tokenOf(plain.notifications.findLast((n) => n.kind === 'activation')!.url!)
      const browser = new Browser(plain.app)
      const { question } = await offered(browser, await activate(browser, token))

      await post(browser, '/activate/passkey', { credential: JSON.stringify(phone.create(question)) })
      await plain.settle()

      const [mail] = plain.notifications.filter((notification) => notification.kind === 'passkey-added')
      expect(mail).toMatchObject({ device: 'Safari, iPhone' })
      expect(mail!.url).toBeUndefined()
    } finally {
      await plain.close()
    }
  })

  describe('with a phone number to confirm first', () => {
    const phoneCode = (email: string) => h.notifications.findLast((notification) => notification.kind === 'phone-code' && notification.user.email === email)!.code!

    it('comes after the phone number is confirmed, and the last page says that it is', async () => {
      h.notifier.smsAvailable = true
      const user = await invited({ withPhone: true })
      const browser = new Browser(h.app)
      const asked = await activate(browser, user.token)
      expect(asked.body).toContain('Confirm your phone number')

      const { question } = await offered(browser, await post(browser, '/activate/phone', { code: phoneCode(user.email) }))
      const done = await post(browser, '/activate/passkey', { credential: JSON.stringify(phone.create(question)) })

      expect(done.body).toContain('Phone number confirmed')
      expect(await passkeysOf(user.id)).toHaveLength(1)
      expect(browser.cookies.has('pforte_phone_step')).toBe(false)
    })

    it('comes after the phone number was skipped', async () => {
      h.notifier.smsAvailable = true
      const user = await invited({ withPhone: true })
      const browser = new Browser(h.app)
      await activate(browser, user.token)

      await offered(browser, await post(browser, '/activate/phone/skip'))

      expect((await post(browser, '/activate/passkey/skip')).body).toContain('Your account is active')
    })

    it('does not come on a device that cannot make a passkey', async () => {
      h.notifier.smsAvailable = true
      const user = await invited({ withPhone: true })
      const browser = new Browser(h.app)
      await activate(browser, user.token, false)

      const done = await post(browser, '/activate/phone', { code: phoneCode(user.email) })

      expect(done.statusCode).toBe(200)
      expect(done.body).toContain('Phone number confirmed')
    })
  })
})
