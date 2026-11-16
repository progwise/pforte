import { rememberDevice } from '@progwise/pforte-db/devices'
import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sign, unsign } from '../interaction/signed-cookie.js'
import { NotifierUnavailableError } from '../notifications/notifier.js'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { Browser, signIn } from '../test/browser.js'
import { createReceiver } from '../test/logout-receiver.js'
import { driveSignIn } from '../test/manage-session.js'

const COOKIE_KEYS = ['k'.repeat(40)]
const WEB = { clientId: 'demo-web', redirectUri: 'http://localhost:3400/callback' }
const BACKEND = { clientId: 'demo-backend', redirectUri: 'http://localhost:3500/callback' }
/** Two people of the seed. Whatever one of them sees or does must never be the other's. */
const A = { email: 'anna.schmidt@example.com' }
const B = { email: 'ben.keller@example.com' }

describe.skipIf(!hasDatabase)('the account pages: sessions, devices, sign-ins and password', () => {
  let h: AdminHarness
  let receiver: Awaited<ReturnType<typeof createReceiver>>
  let passwordHash: string

  beforeAll(async () => {
    h = await createAdminHarness({ allowPrivateAddresses: true })
    receiver = await createReceiver()
    passwordHash = (await h.database.pool.query(`select password_hash from users where email = $1`, [A.email])).rows[0].password_hash
  })

  afterAll(async () => {
    await h?.close()
    await receiver?.close()
  })

  beforeEach(async () => {
    await h.settle()
    h.notifications.length = 0
    h.notifier.failWith = undefined
    receiver.requests.length = 0
    await h.database.pool.query('delete from rate_limits')
    await h.database.pool.query('delete from otp_codes')
    await h.database.pool.query('delete from devices')
    await h.database.pool.query(`delete from audit_events where action like 'login.%'`)
    await h.database.pool.query(`delete from oidc_payloads where account_id in (select id::text from users where email in ($1, $2))`, [A.email, B.email])
    await h.database.pool.query(`update users set status = 'active', locked_at = null, language = 'en', password_hash = $3 where email in ($1, $2)`, [A.email, B.email, passwordHash])
  })

  const idOf = async (email: string) => (await h.database.pool.query(`select id from users where email = $1`, [email])).rows[0].id as string
  const count = async (sql: string, values: unknown[]) => Number((await h.database.pool.query(`select count(*) from ${sql}`, values)).rows[0].count)
  const liveDevices = async (email: string) => count(`devices where user_id = $1 and revoked_at is null`, [await idOf(email)])
  const payloads = async (email: string) => count(`oidc_payloads where account_id = $1`, [await idOf(email)])

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
  /** Submits a form of the area, as the page itself would. */
  const post = (browser: Browser, url: string, form: Record<string, string> = {}) => browser.request('POST', url, { form, headers: { 'sec-fetch-site': 'same-origin' } })
  /** The page the browser lands on after an answer that sent it elsewhere. */
  const follow = async (browser: Browser, response: { headers: Record<string, unknown> }) => browser.request('GET', response.headers.location as string)
  const rowsOf = (body: string) => body.match(/<tr><td>/g)?.length ?? 0
  const lastAudit = async (action: string, email: string) => (await h.audit(action, await idOf(email))).at(-1)

  const PAGES = ['/account/sessions', '/account/devices', '/account/sign-ins', '/account/password']
  const ACTIONS = ['/account/sessions/end', '/account/devices/forget', '/account/devices/forget-all', '/account/password']

  describe('every page', () => {
    it('opens for the person, with the five sections and its own marked', async () => {
      const browser = await signedIn(A.email)
      for (const url of PAGES) {
        const page = await browser.request('GET', url)
        expect(page.statusCode, url).toBe(200)
        for (const href of ['/account', ...PAGES]) expect(page.body, `${url} links to ${href}`).toContain(`<a href="${href}"`)
        expect(page.body).toContain(`<a href="${url}" aria-current="page">`)
        expect(page.body).toContain('Signed in as Anna Schmidt')
        expect(page.headers['cache-control']).toBe('no-store')
        expect(Object.keys(page.headers).filter((name) => name.startsWith('access-control-'))).toEqual([])
      }
    })

    it.each([...PAGES])('%s shows nothing without a sign-in', async (url) => {
      const response = await new Browser(h.app).request('GET', url)
      expect(response.statusCode).toBe(303)
      expect(response.headers.location).toBe(`/account/login?next=${encodeURIComponent(url)}`)
      expect(response.body).toBe('')
    })

    it('is in the language of the person', async () => {
      await h.database.pool.query(`update users set language = 'de' where email = $1`, [A.email])
      const browser = await signedIn(A.email)
      const titles = ['Wo Sie angemeldet sind', 'Gemerkte Geräte', 'Letzte Anmeldungen', 'Passwort ändern']
      for (const [index, url] of PAGES.entries()) expect((await browser.request('GET', url)).body).toContain(`<h1>${titles[index]}</h1>`)
    })
  })

  describe('every change', () => {
    it.each([...ACTIONS])('%s does nothing without a sign-in', async (url) => {
      await rememberDevice(h.database.db, { userId: await idOf(A.email), userAgent: 'A-Phone/1.0' })
      const before = await payloads(A.email)

      const response = await post(new Browser(h.app), url, { device: 'x' })

      expect(response.statusCode).toBe(303)
      // A form is not come back to: what it was about to do is not repeated after the sign-in.
      expect(response.headers.location).toBe('/account/login')
      expect(await liveDevices(A.email)).toBe(1)
      expect(await payloads(A.email)).toBe(before)
      expect(h.notifications).toEqual([])
    })

    it.each([...ACTIONS])('%s is refused from another site', async (url) => {
      const browser = await signedIn(A.email)
      await rememberDevice(h.database.db, { userId: await idOf(A.email) })
      h.notifications.length = 0

      const response = await browser.request('POST', url, { form: { device: 'x' }, headers: { 'sec-fetch-site': 'cross-site' } })

      expect(response.statusCode).toBe(403)
      expect(await liveDevices(A.email)).toBe(1)
      expect((await browser.request('GET', '/account')).statusCode).toBe(200)
      expect(h.notifications).toEqual([])
    })

    it.each([...ACTIONS])('%s asks for a new sign-in when the last one is older than five minutes, and changes nothing before', async (url) => {
      const browser = await signedIn(A.email)
      await rememberDevice(h.database.db, { userId: await idOf(A.email) })
      const before = await payloads(A.email)
      h.notifications.length = 0
      age(browser, 301)

      const response = await post(browser, url, { device: 'x' })

      const back = url === '/account/password' ? url : url.replace(/\/[^/]+$/, '')
      expect(response.statusCode).toBe(303)
      expect(response.headers.location).toBe(`/account/login?again=1&next=${encodeURIComponent(back)}`)
      expect(await liveDevices(A.email)).toBe(1)
      expect(await payloads(A.email)).toBe(before)
      expect(h.notifications).toEqual([])
    })

    it('goes through after the new sign-in, which needs the password and a code although the browser is signed in', async () => {
      const browser = await signedIn(A.email)
      await rememberDevice(h.database.db, { userId: await idOf(A.email) })
      age(browser, 301)
      const sent = await post(browser, '/account/devices/forget-all')
      const codesBefore = h.notifications.filter((n) => n.kind === 'login-code').length

      const { response: page, visited } = await driveSignIn(h, browser, sent.headers.location as string, A.email)

      // Back on the page the person was on, told to repeat it, and nothing done yet. A code was sent on the way:
      // the person was asked for password and code, although the browser had a session.
      expect(visited.at(-1)).toBe('/account/devices')
      expect(h.notifications.filter((n) => n.kind === 'login-code').length).toBe(codesBefore + 1)
      expect(page.body).toContain('For this you had to sign in again. Now repeat what you wanted to do.')
      expect(await liveDevices(A.email)).toBe(1)

      const again = await post(browser, '/account/devices/forget-all')
      expect(again.headers.location).toBe('/account/devices')
      expect(await liveDevices(A.email)).toBe(0)
    })

    it('still goes through at the end of the five minutes', async () => {
      const browser = await signedIn(A.email)
      await rememberDevice(h.database.db, { userId: await idOf(A.email) })
      age(browser, 290)
      expect((await post(browser, '/account/devices/forget-all')).headers.location).toBe('/account/devices')
      expect(await liveDevices(A.email)).toBe(0)
    })

    it('is refused for a person who was locked meanwhile', async () => {
      const browser = await signedIn(A.email)
      await rememberDevice(h.database.db, { userId: await idOf(A.email) })
      await h.database.pool.query(`update users set status = 'locked', locked_at = now() where email = $1`, [A.email])

      const response = await post(browser, '/account/devices/forget-all')

      expect(response.headers.location).toBe('/account/login')
      expect(await liveDevices(A.email)).toBe(1)
    })
  })

  describe('where I am signed in', () => {
    it('lists the browsers and applications of the person, and of nobody else', async () => {
      const account = await signedIn(A.email)
      expect((await signIn(new Browser(h.app), { ...WEB, email: A.email })).code).toBeTruthy()
      expect((await signIn(new Browser(h.app), { ...BACKEND, email: B.email })).code).toBeTruthy()

      const page = await account.request('GET', '/account/sessions')

      // Two browsers: the one of the account pages and the one of the web application.
      expect(page.body).toContain('<h2>Browsers</h2>')
      expect(page.body.match(/<td>With a code<\/td>/g)).toHaveLength(2)
      expect(page.body).toContain('<td>Account</td>')
      expect(page.body).toContain('<td>Demo web app (public client)</td>')
      expect(page.body).not.toContain('Demo backend')
      expect(page.body).toContain('action="/account/sessions/end"')
    })

    it('says so when a browser signed in without a code, on a remembered device', async () => {
      const account = await signedIn(A.email)
      const other = new Browser(h.app)
      const authorize = `/auth?${new URLSearchParams({ client_id: WEB.clientId, redirect_uri: WEB.redirectUri, response_type: 'code', scope: 'openid', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' })}`
      await driveSignIn(h, other, authorize, A.email, { remember: true })
      for (const name of other.cookies.keys()) if (name !== 'pforte_device') other.cookies.delete(name)
      expect((await signIn(other, { ...WEB, email: A.email })).code).toBeTruthy()

      const page = await account.request('GET', '/account/sessions')
      expect(page.body).toContain('<td>Password only, on a remembered device</td>')
    })

    it('signs the person out everywhere: all sessions and devices end, here too, and it is recorded as their own doing', async () => {
      const account = await signedIn(A.email)
      const elsewhere = await signedIn(A.email)
      const bystander = await signedIn(B.email)
      await rememberDevice(h.database.db, { userId: await idOf(A.email) })
      await rememberDevice(h.database.db, { userId: await idOf(B.email) })
      const sessionsOfB = await payloads(B.email)

      const response = await post(account, '/account/sessions/end')

      expect(response.statusCode).toBe(303)
      expect(response.headers.location).toBe('/account/signed-out')
      expect(account.cookies.has('pforte_account')).toBe(false)
      const landing = await follow(account, response)
      expect(landing.body).toContain('You were signed out everywhere and your remembered devices were forgotten.')
      expect(landing.body).toContain('href="/account/login"')
      // The message is shown once.
      expect((await account.request('GET', '/account/signed-out')).body).not.toContain('signed out everywhere')

      expect(await payloads(A.email)).toBe(0)
      expect(await liveDevices(A.email)).toBe(0)
      expect((await elsewhere.request('GET', '/account')).statusCode).toBe(303)

      const event = await lastAudit('user.sessions.end', A.email)
      expect(event).toMatchObject({ actor_type: 'user', actor_id: await idOf(A.email) })
      expect(event.details).toMatchObject({ self: true, email: A.email, devicesRevoked: 1 })
      expect(event.details.sessionsEnded).toBeGreaterThan(0)

      // Nobody else is touched.
      expect(await payloads(B.email)).toBe(sessionsOfB)
      expect(await liveDevices(B.email)).toBe(1)
      expect((await bystander.request('GET', '/account')).statusCode).toBe(200)
    })

    it('says so in the language of the person, although the page no longer knows who they are', async () => {
      await h.database.pool.query(`update users set language = 'hu' where email = $1`, [A.email])
      const account = await signedIn(A.email)
      const landing = await follow(account, await post(account, '/account/sessions/end'))
      expect(landing.body).toContain('<html lang="hu">')
      expect(landing.body).toContain('<h1>Ki van jelentkezve</h1>')
      expect(landing.body).toContain('Mindenhol kijelentkeztettük, és a megjegyzett eszközeit elfelejtettük.')
    })

    it('tells the applications of the person, as when an administrator does it', async () => {
      const set = await h.api('PATCH', `/clients/${WEB.clientId}`, { body: { backchannelLogoutUri: receiver.address('/web') } })
      expect(set.statusCode, set.body).toBe(200)
      try {
        const account = await signedIn(A.email)
        expect((await signIn(new Browser(h.app), { ...WEB, email: A.email })).code).toBeTruthy()

        await post(account, '/account/sessions/end')
        await h.settle()

        expect(receiver.requests.map((request) => request.path)).toEqual(['/web'])
        expect((await lastAudit('user.sessions.end', A.email)).details).toMatchObject({ clientsToNotify: 1, self: true })
      } finally {
        await h.api('PATCH', `/clients/${WEB.clientId}`, { body: { backchannelLogoutUri: null } })
      }
    })
  })

  describe('remembered devices', () => {
    const remember = async (email: string, userAgent?: string) => {
      await rememberDevice(h.database.db, { userId: await idOf(email), userAgent })
      return (await h.database.pool.query(`select id from devices where user_id = $1 order by created_at desc, id desc limit 1`, [await idOf(email)])).rows[0].id as string
    }

    it('says so when there are none', async () => {
      const page = await (await signedIn(A.email)).request('GET', '/account/devices')
      expect(page.body).toContain('No device is remembered. Every sign-in asks for a code.')
      expect(page.body).not.toContain('<table')
    })

    it('lists the devices of the person, and of nobody else', async () => {
      const first = await remember(A.email, 'A-Laptop/1.0')
      const second = await remember(A.email)
      const theirs = await remember(B.email, 'B-Phone/1.0')

      const page = await (await signedIn(A.email)).request('GET', '/account/devices')

      expect(rowsOf(page.body)).toBe(2)
      expect(page.body).toContain('<td>A-Laptop/1.0</td>')
      expect(page.body).toContain('<td>Unknown browser</td>')
      expect(page.body).toContain(`name="device" value="${first}"`)
      expect(page.body).toContain(`name="device" value="${second}"`)
      expect(page.body).not.toContain('B-Phone')
      expect(page.body).not.toContain(theirs)
    })

    it('forgets one device, and records it as the person’s own doing', async () => {
      const laptop = await remember(A.email, 'A-Laptop/1.0')
      await remember(A.email, 'A-Phone/1.0')
      const browser = await signedIn(A.email)

      const response = await post(browser, '/account/devices/forget', { device: laptop })

      expect(response.headers.location).toBe('/account/devices')
      const page = await follow(browser, response)
      expect(page.body).toContain('<p class="flash ok" role="status">The device was forgotten.</p>')
      expect(page.body).not.toContain('A-Laptop')
      expect(page.body).toContain('A-Phone')
      expect(await liveDevices(A.email)).toBe(1)
      const event = await lastAudit('user.device.revoke', A.email)
      expect(event).toMatchObject({ actor_type: 'user', actor_id: await idOf(A.email) })
      expect(event.details).toMatchObject({ self: true, deviceId: laptop, userAgent: 'A-Laptop/1.0' })
    })

    it('does not forget the device of somebody else: it answers as for one that does not exist', async () => {
      await remember(A.email, 'A-Laptop/1.0')
      const theirs = await remember(B.email, 'B-Phone/1.0')
      const browser = await signedIn(A.email)
      const recorded = async (email: string) => (await h.audit('user.device.revoke', await idOf(email))).length
      const [recordedForA, recordedForB] = [await recorded(A.email), await recorded(B.email)]

      for (const device of [theirs, '018f0000-0000-7000-8000-000000000000']) {
        const response = await post(browser, '/account/devices/forget', { device })
        expect(response.headers.location).toBe('/account/devices')
        expect((await follow(browser, response)).body).toContain('<p class="flash error" role="alert">That device is not remembered any more.</p>')
      }

      expect(await liveDevices(B.email)).toBe(1)
      expect(await liveDevices(A.email)).toBe(1)
      // Nothing was recorded either: nothing happened.
      expect(await recorded(A.email)).toBe(recordedForA)
      expect(await recorded(B.email)).toBe(recordedForB)
    })

    it.each(['', 'x', "' or 1=1 --", '../devices', '018f0000'])('answers the same for a device called "%s", without an error', async (device) => {
      await remember(A.email)
      const browser = await signedIn(A.email)
      const response = await post(browser, '/account/devices/forget', { device })
      expect(response.statusCode).toBe(303)
      expect((await follow(browser, response)).body).toContain('That device is not remembered any more.')
      expect(await liveDevices(A.email)).toBe(1)
    })

    it('forgets all devices of the person, and none of anybody else', async () => {
      await remember(A.email)
      await remember(A.email)
      await remember(B.email)
      const browser = await signedIn(A.email)

      const response = await post(browser, '/account/devices/forget-all')

      expect((await follow(browser, response)).body).toContain('All devices were forgotten.')
      expect(await liveDevices(A.email)).toBe(0)
      expect(await liveDevices(B.email)).toBe(1)
      expect((await lastAudit('user.devices.revoke', A.email)).details).toMatchObject({ self: true, devicesRevoked: 2 })
      // The sign-in itself goes on: only the devices went.
      expect((await browser.request('GET', '/account')).statusCode).toBe(200)
    })
  })

  describe('recent sign-ins', () => {
    const wrongPassword = (email: string, userAgent: string) =>
      (async () => {
        const browser = new Browser(h.app)
        const query = new URLSearchParams({ client_id: WEB.clientId, redirect_uri: WEB.redirectUri, response_type: 'code', scope: 'openid', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' })
        const interaction = (await browser.request('GET', `/auth?${query}`)).headers.location as string
        await browser.request('GET', interaction)
        const attempt = await browser.request('POST', `${interaction}/login`, { form: { email, password: 'not-the-password' }, headers: { 'user-agent': userAgent } })
        expect(attempt.statusCode).toBe(401)
      })()

    it('shows what happened to the account of the person, and to nobody else’s', async () => {
      await wrongPassword(A.email, 'Stranger-Browser/1.0')
      await wrongPassword(B.email, 'Other-Stranger/2.0')
      const browser = await signedIn(A.email)

      const page = await browser.request('GET', '/account/sign-ins')

      // The wrong password and the sign-in of a moment ago. The code that was sent on the way is not a line.
      expect(rowsOf(page.body)).toBe(2)
      expect(page.body).toContain('<td>Wrong password</td>')
      expect(page.body).toContain('<td>Stranger-Browser/1.0</td>')
      expect(page.body).toContain('<td>Signed in with a code</td>')
      expect(page.body.indexOf('Signed in with a code')).toBeLessThan(page.body.indexOf('Wrong password'))
      expect(page.body).not.toContain('Other-Stranger')
    })

    it('shows the last ten, newest first, with what each of them was', async () => {
      const userId = await idOf(A.email)
      const browser = await signedIn(A.email)
      await h.database.pool.query(`delete from audit_events where action like 'login.%'`)
      const kinds: [string, object][] = [
        ['login.succeeded', { method: 'code', acr: 'urn:pforte:acr:mfa' }],
        ['login.succeeded', { method: 'remembered_device', acr: 'urn:pforte:acr:pwd' }],
        ['login.password_failed', { reason: 'wrong_password' }],
        ['login.code_failed', { purpose: 'login', reason: 'wrong' }],
        ['login.blocked', { scope: 'password' }],
        ['login.code_sent', { purpose: 'login', channel: 'email' }],
      ]
      for (let index = 0; index < 18; index++) {
        const [action, details] = kinds[index % kinds.length]!
        await h.database.pool.query(
          `insert into audit_events (actor_type, actor_id, action, target_type, target_id, details, ip, user_agent, created_at) values ('user', $1, $2, 'user', $1, $3, $4, 'Probe/1.0', now() - make_interval(mins => $5))`,
          [userId, action, JSON.stringify(details), `203.0.113.${index}`, 100 - index],
        )
      }

      const page = await browser.request('GET', '/account/sign-ins')

      expect(rowsOf(page.body)).toBe(10)
      for (const label of ['Signed in with a code', 'Signed in on a remembered device', 'Wrong password', 'Wrong code', 'Held back after too many attempts']) expect(page.body).toContain(`<td>${label}</td>`)
      // Index 17 is a code that was sent and is left out; 16 is the newest line, 5 and 11 are left out as well.
      expect(page.body).toContain('<td>203.0.113.16</td>')
      expect(page.body).not.toContain('203.0.113.17<')
      expect(page.body).not.toContain('203.0.113.11<')
      expect(page.body.indexOf('203.0.113.16<')).toBeLessThan(page.body.indexOf('203.0.113.15<'))
    })

    it('says so when nothing is recorded', async () => {
      const browser = await signedIn(A.email)
      await h.database.pool.query(`delete from audit_events where action like 'login.%'`)
      const page = await browser.request('GET', '/account/sign-ins')
      expect(page.body).toContain('Nothing has been recorded yet.')
      expect(page.body).not.toContain('<table')
    })
  })

  describe('a new password', () => {
    const resetCodes = () => h.notifications.filter((n) => n.kind === 'reset-code')

    it('has no password field: it offers to send a code', async () => {
      const page = await (await signedIn(A.email)).request('GET', '/account/password')
      expect(page.body).toContain('<h1>Change your password</h1>')
      expect(page.body).toContain('action="/account/password"')
      expect(page.body).not.toMatch(/<input/)
    })

    it('sends the code of the existing reset to the person and continues on its page, with nothing ended yet', async () => {
      const browser = await signedIn(A.email)
      await signedIn(B.email)

      const response = await post(browser, '/account/password')

      expect(response.statusCode).toBe(303)
      expect(response.headers.location).toBe(`/reset/code?email=${encodeURIComponent(A.email)}&lang=en`)
      expect(resetCodes()).toEqual([expect.objectContaining({ user: expect.objectContaining({ email: A.email }) })])
      expect((await follow(browser, response)).body).toContain('name="code"')
      // Asking is not changing: the person is still signed in until the new password is set.
      expect((await browser.request('GET', '/account')).statusCode).toBe(200)

      const userId = await idOf(A.email)
      expect(await lastAudit('user.password_reset.request', A.email)).toMatchObject({ actor_type: 'user', actor_id: userId, details: { self: true } })
      expect((await lastAudit('login.code_sent', A.email)).details).toMatchObject({ purpose: 'password_reset', channel: 'email' })
    })

    it('changes the password through the reset: every session ends, the old password too, and the person is told by mail', async () => {
      const browser = await signedIn(A.email)
      const elsewhere = await signedIn(A.email)
      const bystander = await signedIn(B.email)
      await post(browser, '/account/password')

      const done = await new Browser(h.app).request('POST', '/reset/code', { form: { email: A.email, code: h.lastResetCode(A.email)!, password: 'a brand new password', confirm: 'a brand new password' } })
      await h.settle()

      expect(done.statusCode, done.body).toBe(200)
      expect((await browser.request('GET', '/account')).statusCode).toBe(303)
      expect((await elsewhere.request('GET', '/account')).statusCode).toBe(303)
      expect((await bystander.request('GET', '/account')).statusCode).toBe(200)
      expect((await signIn(new Browser(h.app), { ...WEB, email: A.email })).login.statusCode).toBe(401)
      expect((await signIn(new Browser(h.app), { ...WEB, email: A.email, password: 'a brand new password' })).code).toBeTruthy()
      expect(h.notifications.filter((n) => n.kind === 'password-changed').map((n) => n.user.email)).toEqual([A.email])
      expect(await lastAudit('user.password_reset.complete', A.email)).toMatchObject({ actor_type: 'user', actor_id: await idOf(A.email) })
    })

    it('does not send a second code right away, and says how long to wait', async () => {
      const browser = await signedIn(A.email)
      await post(browser, '/account/password')

      const again = await post(browser, '/account/password')

      expect(again.headers.location).toBe('/account/password')
      expect((await follow(browser, again)).body).toMatch(/<p class="flash error" role="alert">A code was asked for too often\. Please try again in \d+ minutes\.<\/p>/)
      expect(resetCodes()).toHaveLength(1)
    })

    it('counts against the same limit as the page for a forgotten password', async () => {
      const browser = await signedIn(A.email)
      const form = () => new Browser(h.app).request('POST', '/reset', { form: { email: A.email } })
      // The public page is asked until it holds this address back.
      let held = false
      for (let attempt = 0; attempt < 12 && !held; attempt++) held = (await form()).statusCode === 429
      await h.settle()
      expect(held).toBe(true)
      const sentBefore = resetCodes().length

      const response = await post(browser, '/account/password')

      expect(response.headers.location).toBe('/account/password')
      expect((await follow(browser, response)).body).toContain('A code was asked for too often.')
      expect(resetCodes()).toHaveLength(sentBefore)
    })

    it('says so when the code cannot be sent, and stays on the page', async () => {
      const browser = await signedIn(A.email)
      h.notifier.failWith = new NotifierUnavailableError('SMTP is down')

      const response = await post(browser, '/account/password')

      expect(response.headers.location).toBe('/account/password')
      expect((await follow(browser, response)).body).toContain('<p class="flash error" role="alert">The code could not be sent. Please try again later.</p>')
    })

    it('sends the code to nobody else, whatever the form carries', async () => {
      const browser = await signedIn(A.email)
      await post(browser, '/account/password', { email: B.email, user: await idOf(B.email), userId: await idOf(B.email) })
      expect(resetCodes().map((n) => n.user.email)).toEqual([A.email])
    })
  })
})
