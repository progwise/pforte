import { createHmac } from 'node:crypto'
import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NotifierUnavailableError } from '../notifications/notifier.js'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { Browser, pkcePair, signIn, verifyJwt } from '../test/browser.js'

const WEB = { clientId: 'demo-web', redirectUri: 'http://localhost:3400/callback' }

describe.skipIf(!hasDatabase)('second factor at sign-in', () => {
  let h: AdminHarness

  beforeAll(async () => {
    h = await createAdminHarness()
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(async () => {
    h.notifications.length = 0
    h.notifier.failWith = undefined
    h.notifier.smsAvailable = false
    // Every test starts from users who have never signed in with a code and have no phone number.
    await h.database.pool.query(`delete from otp_codes`)
    await h.database.pool.query(`update users set phone = null, email_verified_at = null, last_login_at = null, status = 'active' where password_hash is not null`)
  })

  const query = () => {
    const { challenge, verifier } = pkcePair()
    return {
      verifier,
      query: new URLSearchParams({
        client_id: WEB.clientId,
        redirect_uri: WEB.redirectUri,
        response_type: 'code',
        scope: 'openid',
        state: 's',
        nonce: 'n',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    }
  }

  /** Authorizes and enters the password. Returns where the browser is sent next. */
  const passwordStep = async (email: string, { password = 'dev-password' } = {}) => {
    const browser = new Browser(h.app)
    const { query: params, verifier } = query()
    const authorize = await browser.request('GET', `/auth?${params}`)
    const interaction = authorize.headers.location as string
    await browser.request('GET', interaction)
    const login = await browser.request('POST', `${interaction}/login`, { form: { email, password } })
    return { browser, interaction, login, verifier }
  }

  const codeFor = (email: string) => h.notifications.findLast((n) => n.kind === 'login-code' && n.user.email === email)!.code!
  const user = (email: string) => h.database.pool.query(`select * from users where email = $1`, [email]).then((result) => result.rows[0])

  it('sends a code after the right password and asks for it before signing in', async () => {
    const { browser, interaction, login } = await passwordStep('felix.brandt@example.com')

    expect(login.statusCode).toBe(303)
    expect(login.headers.location).toBe(`${interaction}/code`)
    expect(h.notifications).toEqual([expect.objectContaining({ kind: 'login-code', user: expect.objectContaining({ email: 'felix.brandt@example.com' }) })])
    expect(codeFor('felix.brandt@example.com')).toMatch(/^\d{6}$/)

    // Not signed in yet: the authorization request still needs the interaction.
    const silent = await browser.request('GET', `/auth?${query().query}&prompt=none`)
    expect(silent.headers.location).toContain('error=login_required')
    expect((await user('felix.brandt@example.com')).last_login_at).toBeNull()
  })

  it('does not send a code for a wrong password', async () => {
    const { login } = await passwordStep('greta.lang@example.com', { password: 'wrong' })
    expect(login.statusCode).toBe(401)
    expect(h.notifications).toEqual([])
  })

  it('shows the masked address, and the hint to add a phone number where SMS is possible', async () => {
    h.notifier.smsAvailable = true
    const { browser, interaction } = await passwordStep('hans.weber@example.com')
    const page = await browser.request('GET', `${interaction}/code`)

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('by e-mail to h***@example.com')
    expect(page.body).not.toContain('hans.weber@example.com')
    expect(page.body).toContain('no mobile number is on file')
  })

  it('leaves out the hint where SMS cannot be sent anyway', async () => {
    const { browser, interaction } = await passwordStep('hans.weber@example.com')
    expect((await browser.request('GET', `${interaction}/code`)).body).not.toContain('no mobile number')
  })

  it('leaves out the hint for a user who has a phone number', async () => {
    await h.database.pool.query(`update users set phone = '+4915112345678' where email = 'ben.keller@example.com'`)
    const { browser, interaction } = await passwordStep('ben.keller@example.com')
    expect((await browser.request('GET', `${interaction}/code`)).body).not.toContain('no mobile number')
  })

  it('signs in with the right code and tells the application how: acr, amr and email_verified', async () => {
    const email = 'anna.schmidt@example.com'
    expect((await user(email)).email_verified_at).toBeNull()
    const { browser, interaction, verifier } = await passwordStep(email)

    const entered = await browser.request('POST', `${interaction}/code`, { form: { code: codeFor(email) } })
    expect(entered.statusCode).toBe(303)
    const resumed = await browser.request('GET', entered.headers.location as string)
    const code = new URL(resumed.headers.location as string).searchParams.get('code')!
    const tokens = (
      await browser.request('POST', '/token', {
        form: { grant_type: 'authorization_code', code, redirect_uri: WEB.redirectUri, client_id: WEB.clientId, code_verifier: verifier },
      })
    ).json()
    const { claims } = await verifyJwt(h.app, tokens.id_token)

    expect(claims).toMatchObject({ acr: 'urn:pforte:acr:mfa', amr: ['pwd', 'otp'], email_verified: true, email })
    const row = await user(email)
    expect(row.email_verified_at).not.toBeNull()
    expect(row.last_login_at).not.toBeNull()
  })

  it('uses a code only once', async () => {
    const email = 'ben.keller@example.com'
    const { browser, interaction } = await passwordStep(email)
    const code = codeFor(email)

    expect((await browser.request('POST', `${interaction}/code`, { form: { code } })).statusCode).toBe(303)
    // The step is over: a second attempt with the same code starts again at the password.
    const again = await browser.request('POST', `${interaction}/code`, { form: { code } })
    expect(again.headers.location).toBe(interaction)
  })

  it('refuses a wrong code, lets the user try again, and invalidates the code at the sixth attempt', async () => {
    const email = 'greta.lang@example.com'
    const { browser, interaction } = await passwordStep(email)
    const right = codeFor(email)
    const wrong = right === '000000' ? '000001' : '000000'

    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await browser.request('POST', `${interaction}/code`, { form: { code: wrong } })
      expect(response.statusCode).toBe(401)
      expect(response.body).toContain('The code is not correct.')
    }
    const sixth = await browser.request('POST', `${interaction}/code`, { form: { code: right } })
    expect(sixth.statusCode).toBe(401)
    expect(sixth.body).toContain('Too many wrong attempts')
  })

  it('treats input that is not six digits as wrong, and ignores spaces', async () => {
    const email = 'felix.brandt@example.com'
    const { browser, interaction } = await passwordStep(email)
    expect((await browser.request('POST', `${interaction}/code`, { form: { code: 'abcdef' } })).statusCode).toBe(401)
    const code = codeFor(email)
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`
    expect((await browser.request('POST', `${interaction}/code`, { form: { code: spaced } })).statusCode).toBe(303)
  })

  it('waits before sending another code, then sends one and drops the old one', async () => {
    const email = 'hans.weber@example.com'
    const { browser, interaction } = await passwordStep(email)
    const first = codeFor(email)

    const tooSoon = await browser.request('POST', `${interaction}/code/resend`)
    expect(tooSoon.statusCode).toBe(429)
    expect(Number(tooSoon.headers['retry-after'])).toBeGreaterThan(0)
    expect(h.notifications).toHaveLength(1)

    await h.database.pool.query(`update otp_codes set created_at = created_at - interval '2 minutes'`)
    const resent = await browser.request('POST', `${interaction}/code/resend`)
    expect(resent.statusCode).toBe(200)
    expect(resent.body).toContain('A new code is on its way.')
    const second = codeFor(email)

    if (first !== second) {
      expect((await browser.request('POST', `${interaction}/code`, { form: { code: first } })).statusCode).toBe(401)
    }
    expect((await browser.request('POST', `${interaction}/code`, { form: { code: second } })).statusCode).toBe(303)
  })

  it('goes back to the password when the step cookie is missing, forged or for another sign-in', async () => {
    const { interaction, browser } = await passwordStep('greta.lang@example.com')

    const noCookie = await new Browser(h.app).request('GET', `${interaction}/code`)
    expect(noCookie.statusCode).toBe(400) // no interaction session either

    // The same cookie name with a signature made by someone without the key replaces the real one.
    browser.cookies.set('pforte_second_factor', `e30.${createHmac('sha256', 'x').update('e30').digest('base64url')}`)
    const forged = await browser.request('GET', `${interaction}/code`)
    expect(forged.statusCode).toBe(303)
    expect(forged.headers.location).toBe(interaction)

    // A second sign-in in the same browser cannot use the cookie of the first.
    const other = await browser.request('GET', `/auth?${query().query}`)
    const otherInteraction = other.headers.location as string
    await browser.request('GET', otherInteraction)
    const stolen = await browser.request('GET', `${otherInteraction}/code`)
    expect(stolen.statusCode).toBe(303)
    expect(stolen.headers.location).toBe(otherInteraction)
  })

  it('does not finish for a user who was locked after the password step', async () => {
    const email = 'ben.keller@example.com'
    const { browser, interaction } = await passwordStep(email)
    const code = codeFor(email)
    await h.database.pool.query(`update users set status = 'locked' where email = $1`, [email])

    const response = await browser.request('POST', `${interaction}/code`, { form: { code } })
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe(interaction)
    await h.database.pool.query(`update users set status = 'active' where email = $1`, [email])
  })

  it('says so when the code cannot be sent, and signs nobody in', async () => {
    h.notifier.failWith = new NotifierUnavailableError('SMTP is down')
    const { login } = await passwordStep('anna.schmidt@example.com')

    expect(login.statusCode).toBe(503)
    expect(login.body).toContain('could not be sent')
    expect(login.body).not.toContain('SMTP')
    expect(login.headers['set-cookie']).toBeUndefined()
  })

  it('sets a cookie that scripts cannot read and that stays on this sign-in', async () => {
    const { login, interaction } = await passwordStep('felix.brandt@example.com')
    const cookie = [login.headers['set-cookie']].flat().find((header) => header?.startsWith('pforte_second_factor='))!
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain(`Path=${interaction}`)
  })

  it('still lets the whole flow be driven by the helper', async () => {
    const result = await signIn(new Browser(h.app), { ...WEB, email: 'felix.brandt@example.com' })
    expect(result.code).toBeTruthy()
  })
})

describe.skipIf(!hasDatabase)('remembered devices at sign-in', () => {
  let h: AdminHarness

  beforeAll(async () => {
    h = await createAdminHarness()
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(async () => {
    h.notifications.length = 0
    await h.database.pool.query(`delete from otp_codes`)
    await h.database.pool.query(`delete from devices`)
    await h.database.pool.query(`update users set phone = null, email_verified_at = null, status = 'active' where password_hash is not null`)
  })

  const authorize = (extra: Record<string, string> = {}) => {
    const { challenge, verifier } = pkcePair()
    const params = new URLSearchParams({
      client_id: WEB.clientId,
      redirect_uri: WEB.redirectUri,
      response_type: 'code',
      scope: 'openid',
      state: 's',
      nonce: 'n',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...extra,
    })
    return { params, verifier }
  }

  /** Signs in with the password (and the code, remembering the device if asked). Returns the ID token claims. */
  const signInOn = async (browser: Browser, email: string, { remember = false, extra = {} as Record<string, string> } = {}) => {
    // A new visit: the single sign-on session is gone, the remembered device is not.
    for (const name of browser.cookies.keys()) if (name !== 'pforte_device') browser.cookies.delete(name)
    const { params, verifier } = authorize(extra)
    const interaction = (await browser.request('GET', `/auth?${params}`)).headers.location as string
    await browser.request('GET', interaction)
    const password = await browser.request('POST', `${interaction}/login`, { form: { email, password: 'dev-password' } })
    const askedForCode = password.headers.location === `${interaction}/code`
    let finished = password
    if (askedForCode) {
      const code = h.notifications.findLast((n) => n.kind === 'login-code' && n.user.email === email)!.code!
      finished = await browser.request('POST', `${interaction}/code`, { form: { code, ...(remember ? { remember: 'on' } : {}) } })
    }
    const resumed = await browser.request('GET', finished.headers.location as string)
    const code = new URL(resumed.headers.location as string).searchParams.get('code')!
    const tokens = (
      await browser.request('POST', '/token', {
        form: { grant_type: 'authorization_code', code, redirect_uri: WEB.redirectUri, client_id: WEB.clientId, code_verifier: verifier },
      })
    ).json()
    return { askedForCode, claims: (await verifyJwt(h.app, tokens.id_token)).claims, finished }
  }

  const userId = async (email: string) => (await h.database.pool.query(`select id from users where email = $1`, [email])).rows[0].id as string
  const fresh = () => h.database.pool.query(`delete from otp_codes`)

  it('asks for the code until the user chooses to remember the device', async () => {
    const browser = new Browser(h.app)
    const first = await signInOn(browser, 'anna.schmidt@example.com')
    expect(first.askedForCode).toBe(true)
    expect(browser.cookies.has('pforte_device')).toBe(false)

    await fresh()
    const second = await signInOn(browser, 'anna.schmidt@example.com', { remember: true })
    expect(second.askedForCode).toBe(true)
    expect(browser.cookies.has('pforte_device')).toBe(true)
  })

  it('sets the device cookie so that scripts cannot read it and other sites cannot send it', async () => {
    const browser = new Browser(h.app)
    const { finished } = await signInOn(browser, 'ben.keller@example.com', { remember: true })
    const cookie = [finished.headers['set-cookie']].flat().find((header) => header?.startsWith('pforte_device='))!
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain(`Max-Age=${90 * 24 * 60 * 60}`)
  })

  it('skips the code on a remembered device and says so in acr and amr', async () => {
    const browser = new Browser(h.app)
    await signInOn(browser, 'felix.brandt@example.com', { remember: true })
    h.notifications.length = 0

    const again = await signInOn(browser, 'felix.brandt@example.com')
    expect(again.askedForCode).toBe(false)
    expect(h.notifications).toEqual([])
    expect(again.claims).toMatchObject({ acr: 'urn:pforte:acr:pwd', amr: ['pwd'] })
  })

  it('asks for the code on another browser, and for another user on the same browser', async () => {
    const browser = new Browser(h.app)
    await signInOn(browser, 'greta.lang@example.com', { remember: true })

    expect((await signInOn(new Browser(h.app), 'greta.lang@example.com')).askedForCode).toBe(true)
    await fresh()
    expect((await signInOn(browser, 'hans.weber@example.com')).askedForCode).toBe(true)
  })

  it('remembers several people on one browser', async () => {
    const browser = new Browser(h.app)
    await signInOn(browser, 'greta.lang@example.com', { remember: true })
    await fresh()
    await signInOn(browser, 'hans.weber@example.com', { remember: true })

    expect((await signInOn(browser, 'greta.lang@example.com')).askedForCode).toBe(false)
    expect((await signInOn(browser, 'hans.weber@example.com')).askedForCode).toBe(false)
  })

  it('ignores a made-up device cookie', async () => {
    const browser = new Browser(h.app)
    browser.cookies.set('pforte_device', 'made-up-token.another')
    expect((await signInOn(browser, 'anna.schmidt@example.com')).askedForCode).toBe(true)
  })

  it('asks again after the device was revoked through the admin API', async () => {
    const email = 'ben.keller@example.com'
    const browser = new Browser(h.app)
    await signInOn(browser, email, { remember: true })
    expect((await signInOn(browser, email)).askedForCode).toBe(false)

    const id = await userId(email)
    const list = await h.api('GET', `/users/${id}/devices`)
    expect(list.statusCode).toBe(200)
    expect(list.json().items).toHaveLength(1)
    expect(list.json().items[0]).toMatchObject({ userAgent: expect.any(String) })

    const revoked = await h.api('DELETE', `/users/${id}/devices/${list.json().items[0].id}`)
    expect(revoked.statusCode).toBe(204)
    expect((await h.audit('user.device.revoke', id))).toHaveLength(1)

    expect((await signInOn(browser, email)).askedForCode).toBe(true)
  })

  it('asks again after all devices were revoked', async () => {
    const email = 'felix.brandt@example.com'
    const one = new Browser(h.app)
    const two = new Browser(h.app)
    await signInOn(one, email, { remember: true })
    await fresh()
    await signInOn(two, email, { remember: true })

    const revoked = await h.api('DELETE', `/users/${await userId(email)}/devices`)
    expect(revoked.json()).toEqual({ devicesRevoked: 2 })
    expect((await signInOn(one, email)).askedForCode).toBe(true)
    await fresh()
    expect((await signInOn(two, email)).askedForCode).toBe(true)
  })

  it('asks again after ending the sessions of the user, and reports the devices', async () => {
    const email = 'greta.lang@example.com'
    const browser = new Browser(h.app)
    await signInOn(browser, email, { remember: true })

    const ended = await h.api('POST', `/users/${await userId(email)}/end-sessions`)
    expect(ended.json().devicesRevoked).toBe(1)
    expect((await signInOn(browser, email)).askedForCode).toBe(true)
  })

  it('requires the code on a remembered device when the application asks for the stronger assurance', async () => {
    const email = 'hans.weber@example.com'
    const browser = new Browser(h.app)
    await signInOn(browser, email, { remember: true })

    const stepUp = await signInOn(browser, email, { extra: { acr_values: 'urn:pforte:acr:mfa' } })
    expect(stepUp.askedForCode).toBe(true)
    expect(stepUp.claims).toMatchObject({ acr: 'urn:pforte:acr:mfa' })

    // Asking for the weaker one is fine with a remembered device.
    expect((await signInOn(browser, email, { extra: { acr_values: 'urn:pforte:acr:pwd' } })).askedForCode).toBe(false)
  })

  it('does not let a remembered device sign in a user who is locked', async () => {
    const email = 'anna.schmidt@example.com'
    const browser = new Browser(h.app)
    await signInOn(browser, email, { remember: true })
    await h.api('POST', `/users/${await userId(email)}/lock`)

    const { params } = authorize()
    const interaction = (await browser.request('GET', `/auth?${params}`)).headers.location as string
    await browser.request('GET', interaction)
    const login = await browser.request('POST', `${interaction}/login`, { form: { email, password: 'dev-password' } })
    expect(login.statusCode).toBe(401)
  })

  it('answers 404 for unknown users and devices, and requires the directory or admin scope', async () => {
    const unknown = '018f0000-0000-7000-8000-000000000000'
    expect((await h.api('GET', `/users/${unknown}/devices`)).statusCode).toBe(404)
    expect((await h.api('DELETE', `/users/${unknown}/devices`)).statusCode).toBe(404)
    const id = await userId('ben.keller@example.com')
    expect((await h.api('DELETE', `/users/${id}/devices/${unknown}`)).statusCode).toBe(404)
    expect((await h.api('GET', `/users/${id}/devices`, { token: null })).statusCode).toBe(401)
  })
})


describe.skipIf(!hasDatabase)('second factor by SMS', () => {
  let h: AdminHarness
  const NUMBER = '+4915112345678'

  beforeAll(async () => {
    h = await createAdminHarness()
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(async () => {
    h.notifications.length = 0
    h.notifier.failWith = undefined
    h.notifier.failSms = false
    h.notifier.smsAvailable = true
    await h.database.pool.query(`delete from otp_codes`)
    await h.database.pool.query(`delete from devices`)
    await h.database.pool.query(
      `update users set phone = $1, phone_verified_at = now(), email_verified_at = null, status = 'active' where password_hash is not null`,
      [NUMBER],
    )
  })

  const passwordStep = async (email: string) => {
    const browser = new Browser(h.app)
    const { challenge, verifier } = pkcePair()
    const params = new URLSearchParams({
      client_id: WEB.clientId,
      redirect_uri: WEB.redirectUri,
      response_type: 'code',
      scope: 'openid',
      state: 's',
      nonce: 'n',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    const interaction = (await browser.request('GET', `/auth?${params}`)).headers.location as string
    await browser.request('GET', interaction)
    const login = await browser.request('POST', `${interaction}/login`, { form: { email, password: 'dev-password' } })
    return { browser, interaction, login, verifier }
  }
  const lastLoginCode = () => h.notifications.findLast((n) => n.kind === 'login-code')!

  it('sends the code by SMS to a confirmed number and says where it went, without the full number', async () => {
    const { browser, interaction } = await passwordStep('anna.schmidt@example.com')
    expect(lastLoginCode()).toMatchObject({ channel: 'sms', user: expect.objectContaining({ phone: NUMBER }) })

    const page = await browser.request('GET', `${interaction}/code`)
    expect(page.body).toContain('by SMS to +49')
    expect(page.body).toContain('78')
    expect(page.body).not.toContain(NUMBER)
    expect(page.body).toContain('Send the code by e-mail instead')
  })

  it('signs in with the SMS code: amr says sms, and the e-mail is not claimed to be verified', async () => {
    const email = 'ben.keller@example.com'
    const { browser, interaction, verifier } = await passwordStep(email)
    const entered = await browser.request('POST', `${interaction}/code`, { form: { code: lastLoginCode().code! } })
    const resumed = await browser.request('GET', entered.headers.location as string)
    const code = new URL(resumed.headers.location as string).searchParams.get('code')!
    const tokens = (
      await browser.request('POST', '/token', {
        form: { grant_type: 'authorization_code', code, redirect_uri: WEB.redirectUri, client_id: WEB.clientId, code_verifier: verifier },
      })
    ).json()

    const { claims } = await verifyJwt(h.app, tokens.id_token)
    expect(claims).toMatchObject({ acr: 'urn:pforte:acr:mfa', amr: ['pwd', 'sms'], email_verified: false })
    expect((await h.database.pool.query(`select email_verified_at from users where email = $1`, [email])).rows[0].email_verified_at).toBeNull()
  })

  it('uses e-mail when the number was never confirmed, or when SMS is not available', async () => {
    await h.database.pool.query(`update users set phone_verified_at = null where email = 'felix.brandt@example.com'`)
    await passwordStep('felix.brandt@example.com')
    expect(lastLoginCode().channel).toBe('email')

    h.notifications.length = 0
    h.notifier.smsAvailable = false
    await h.database.pool.query(`delete from otp_codes`)
    await passwordStep('greta.lang@example.com')
    expect(lastLoginCode().channel).toBe('email')
  })

  it('sends the same code by e-mail when the SMS provider is down', async () => {
    h.notifier.failSms = true
    const email = 'hans.weber@example.com'
    const { browser, interaction } = await passwordStep(email)

    expect(h.notifications).toHaveLength(1)
    expect(lastLoginCode().channel).toBe('email')
    const page = await browser.request('GET', `${interaction}/code`)
    expect(page.body).toContain('by e-mail to')
    expect(page.body).not.toContain('e-mail instead')
    const entered = await browser.request('POST', `${interaction}/code`, { form: { code: lastLoginCode().code! } })
    expect(entered.statusCode).toBe(303)
    expect((await h.database.pool.query(`select email_verified_at from users where email = $1`, [email])).rows[0].email_verified_at).not.toBeNull()
  })

  it('fails clearly when neither SMS nor e-mail can be sent', async () => {
    h.notifier.failWith = new NotifierUnavailableError('everything is down')
    const { login } = await passwordStep('anna.schmidt@example.com')
    expect(login.statusCode).toBe(503)
  })

  it('sends the code by e-mail on request, after the wait, and drops the SMS code', async () => {
    const email = 'felix.brandt@example.com'
    const { browser, interaction } = await passwordStep(email)
    const smsCode = lastLoginCode().code!

    const tooSoon = await browser.request('POST', `${interaction}/code/resend`, { form: { channel: 'email' } })
    expect(tooSoon.statusCode).toBe(429)

    await h.database.pool.query(`update otp_codes set created_at = created_at - interval '2 minutes'`)
    const switched = await browser.request('POST', `${interaction}/code/resend`, { form: { channel: 'email' } })
    expect(switched.statusCode).toBe(200)
    expect(switched.body).toContain('by e-mail to')
    expect(lastLoginCode().channel).toBe('email')

    if (smsCode !== lastLoginCode().code) {
      expect((await browser.request('POST', `${interaction}/code`, { form: { code: smsCode } })).statusCode).toBe(401)
    }
    expect((await browser.request('POST', `${interaction}/code`, { form: { code: lastLoginCode().code! } })).statusCode).toBe(303)
  })

  it('sends the next code the usual way when no channel is asked for', async () => {
    const { browser, interaction } = await passwordStep('greta.lang@example.com')
    await h.database.pool.query(`update otp_codes set created_at = created_at - interval '2 minutes'`)
    await browser.request('POST', `${interaction}/code/resend`)
    expect(lastLoginCode().channel).toBe('sms')
  })
})
