import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NotifierUnavailableError } from '../notifications/notifier.js'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { Browser, signIn } from '../test/browser.js'

const WEB = { clientId: 'demo-web', redirectUri: 'http://localhost:3400/callback' }

describe.skipIf(!hasDatabase)('admin API: user lifecycle', () => {
  let h: AdminHarness

  beforeAll(async () => {
    h = await createAdminHarness()
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(() => {
    h.notifications.length = 0
    h.notifier.failWith = undefined
  })

  /** A seeded user with a password, found by e-mail. */
  const seeded = async (email: string) => (await h.api('GET', `/users?search=${email}`)).json().items[0] as { id: string; status: string; email: string }

  const act = (id: string, action: string, token = h.adminToken) => h.api('POST', `/users/${id}/${action}`, { token })

  /** Signs the user in and returns what they would hold: a browser with a session and a refresh token. */
  const signedIn = async (email: string) => {
    const browser = new Browser(h.app)
    const { code, verifier } = await signIn(browser, { ...WEB, email })
    const tokens = (
      await browser.request('POST', '/token', {
        form: {
          grant_type: 'authorization_code',
          code: code!,
          redirect_uri: WEB.redirectUri,
          client_id: WEB.clientId,
          code_verifier: verifier,
        },
      })
    ).json()
    return { browser, tokens }
  }

  const refresh = (browser: Browser, refreshToken: string) =>
    browser.request('POST', '/token', { form: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: WEB.clientId } })

  /** True while the browser still has a session: a silent authorization request returns a code. */
  const hasSession = async (browser: Browser) => {
    const query = new URLSearchParams({
      client_id: WEB.clientId,
      redirect_uri: WEB.redirectUri,
      response_type: 'code',
      scope: 'openid',
      prompt: 'none',
      state: 's',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
    })
    const response = await browser.request('GET', `/auth?${query}`)
    return new URL(response.headers.location as string, 'https://localhost:3300').searchParams.has('code')
  }

  const canSignIn = async (email: string) => {
    const { login } = await signIn(new Browser(h.app), { ...WEB, email })
    return login.statusCode === 303
  }

  describe('locking', () => {
    it('ends the session and refresh token of a signed-in user, and stops further sign-ins', async () => {
      const user = await seeded('ben.keller@example.com')
      const { browser, tokens } = await signedIn(user.email)
      expect(await hasSession(browser)).toBe(true)

      const response = await act(user.id, 'lock')

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ status: 'locked' })
      expect(await hasSession(browser), 'the browser session is gone').toBe(false)
      expect((await refresh(browser, tokens.refresh_token)).json().error, 'the refresh token is revoked').toBe('invalid_grant')
      expect(await canSignIn(user.email), 'a locked user cannot sign in').toBe(false)
    })

    it('lets the user sign in again after unlocking', async () => {
      const user = await seeded('ben.keller@example.com')

      const unlocked = await act(user.id, 'unlock')

      expect(unlocked.json().status).toBe('active')
      expect(await canSignIn(user.email)).toBe(true)
    })

    it('records who locked whom, and how many sessions ended', async () => {
      const user = await seeded('carla.berger@example.com')
      await signedIn(user.email)

      await act(user.id, 'lock')

      const [event] = await h.audit('user.lock', user.id)
      expect(event).toMatchObject({ actor_id: 'demo-admin' })
      expect(event.details.sessionsEnded).toBeGreaterThan(0)
      await act(user.id, 'unlock')
    })
  })

  describe('deactivating, deleting and ending sessions', () => {
    it('deactivate ends the sessions and refuses sign-in', async () => {
      const user = await seeded('david.roth@example.com')
      const { browser, tokens } = await signedIn(user.email)

      const response = await act(user.id, 'deactivate')

      expect(response.json().status).toBe('deactivated')
      expect(await hasSession(browser)).toBe(false)
      expect((await refresh(browser, tokens.refresh_token)).statusCode).toBe(400)
      expect(await canSignIn(user.email)).toBe(false)
    })

    it('deleting a user ends their refresh token as well', async () => {
      const user = await seeded('felix.brandt@example.com')
      const { browser, tokens } = await signedIn(user.email)

      expect((await h.api('DELETE', `/users/${user.id}`)).statusCode).toBe(204)

      expect((await refresh(browser, tokens.refresh_token)).statusCode).toBe(400)
      expect(await hasSession(browser)).toBe(false)
    })

    it('end-sessions signs the user out everywhere but keeps them active', async () => {
      const user = await seeded('greta.lang@example.com')
      const desktop = await signedIn(user.email)
      const phone = await signedIn(user.email)

      const response = await act(user.id, 'end-sessions')

      expect(response.json().sessionsEnded).toBeGreaterThanOrEqual(4)
      expect(await hasSession(desktop.browser)).toBe(false)
      expect((await refresh(phone.browser, phone.tokens.refresh_token)).statusCode).toBe(400)
      expect((await seeded(user.email)).status).toBe('active')
      expect(await canSignIn(user.email)).toBe(true)
    })

    it('leaves the sessions of other users alone', async () => {
      const target = await seeded('hans.weber@example.com')
      const bystander = await seeded('ida.sommer@example.com')
      const { browser } = await signedIn(bystander.email)

      await act(target.id, 'end-sessions')

      expect(await hasSession(browser)).toBe(true)
    })
  })

  describe('activation', () => {
    const createdUser = async (email: string) =>
      (await h.api('POST', '/users', { body: { email, firstName: 'New', lastName: 'Hire' } })).json() as { id: string; email: string }

    it('names the client in the e-mail and keeps the choice with the link', async () => {
      const user = await createdUser('hire-client@example.com')
      const response = await h.api('POST', `/users/${user.id}/activate`, { body: { clientId: 'demo-web' } })

      expect(response.statusCode, response.body).toBe(200)
      expect(h.notifications.findLast((n) => n.kind === 'activation')).toMatchObject({ applicationName: 'Demo web app (public client)' })
      const row = (await h.database.pool.query(`select activation_client_id from users where id = $1`, [user.id])).rows[0]
      expect(row.activation_client_id).toBe('demo-web')
      const [event] = await h.audit('user.activate', user.id)
      expect(event.details).toMatchObject({ clientId: 'demo-web' })

      // A later call without a client replaces the choice together with the link.
      await h.api('POST', `/users/${user.id}/activate`)
      expect(h.notifications.findLast((n) => n.kind === 'activation')!.applicationName).toBeUndefined()
      const again = (await h.database.pool.query(`select activation_client_id from users where id = $1`, [user.id])).rows[0]
      expect(again.activation_client_id).toBeNull()
    })

    it('answers 400 for a client that does not exist, and sends nothing', async () => {
      const user = await createdUser('hire-nobody@example.com')
      const before = h.notifications.length
      const response = await h.api('POST', `/users/${user.id}/activate`, { body: { clientId: 'nobody' } })

      expect(response.statusCode).toBe(400)
      expect(response.json().detail).toContain('nobody')
      expect(h.notifications).toHaveLength(before)
      expect((await h.api('GET', `/users/${user.id}`)).json().status).toBe('created')
    })

    it('sends the activation link to the notifier and never returns it', async () => {
      const user = await createdUser('hire1@example.com')

      const response = await act(user.id, 'activate')

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ user: { status: 'created' }, activation: { linkSent: true } })
      expect(h.notifications).toHaveLength(1)
      const [sent] = h.notifications
      expect(sent!.user.email).toBe('hire1@example.com')
      expect(sent!.url).toMatch(/^https:\/\/localhost:3300\/activate\?token=[\w-]{43,}$/)
      expect(sent!.expiresAt!.getTime()).toBeGreaterThan(Date.now())

      const token = new URL(sent!.url!).searchParams.get('token')!
      expect(response.body).not.toContain(token)
      const [event] = await h.audit('user.activate', user.id)
      expect(JSON.stringify(event)).not.toContain(token)
    })

    it('replaces the earlier link when activation is started again', async () => {
      const user = await createdUser('hire2@example.com')
      await act(user.id, 'activate')
      await act(user.id, 'activate')

      expect(h.notifications).toHaveLength(2)
      expect(h.notifications[0]!.url).not.toBe(h.notifications[1]!.url)
    })

    it('reactivates a deactivated user who has a password without a link', async () => {
      const user = await seeded('jonas.fuchs@example.com')
      await act(user.id, 'deactivate')

      const response = await act(user.id, 'activate')

      expect(response.json()).toMatchObject({ user: { status: 'active' }, activation: { linkSent: false, expiresAt: null } })
      expect(h.notifications).toHaveLength(0)
      expect(await canSignIn(user.email)).toBe(true)
    })

    it('says so when the message cannot be sent, and keeps the change', async () => {
      const user = await createdUser('hire3@example.com')
      h.notifier.failWith = new NotifierUnavailableError('No way to send messages is configured.')

      const response = await act(user.id, 'activate')

      expect(response.statusCode).toBe(503)
      expect(response.headers['content-type']).toMatch(/application\/problem\+json/)
      expect(response.json().detail).toContain('repeat the call')
      expect((await h.audit('user.activate', user.id)).length).toBe(1)
    })
  })

  describe('password reset', () => {
    it('asks the notifier for a reset and ends the sessions of an active user', async () => {
      const user = await seeded('anna.schmidt@example.com')
      const { browser, tokens } = await signedIn(user.email)

      const response = await act(user.id, 'reset-password')

      expect(response.statusCode).toBe(200)
      expect(h.notifications.filter((n) => n.kind !== 'login-code')).toEqual([expect.objectContaining({ kind: 'reset-code', user: expect.objectContaining({ email: user.email }) })])
      expect(await hasSession(browser)).toBe(false)
      expect((await refresh(browser, tokens.refresh_token)).statusCode).toBe(400)
      expect((await h.audit('user.password_reset.request', user.id))[0].details.sessionsEnded).toBeGreaterThan(0)
    })

    it('refuses a user who is not active', async () => {
      const created = (await h.api('POST', '/users', { body: { email: 'no-reset@example.com', firstName: 'No', lastName: 'Reset' } })).json()

      const response = await act(created.id, 'reset-password')

      expect(response.statusCode).toBe(409)
      expect(h.notifications).toHaveLength(0)
    })
  })

  describe('confirming a phone number for an application', () => {
    const NUMBER = '+4915112345678'
    let counter = 0

    beforeEach(async () => {
      h.notifier.smsAvailable = true
      h.notifier.failSms = false
      await h.database.pool.query('delete from otp_codes')
    })

    /** An active person with a number nobody has confirmed, as after a change by the back office. */
    const unconfirmed = async () => {
      const email = `phone${++counter}@example.com`
      const created = (await h.api('POST', '/users', { body: { email, firstName: 'Pia', lastName: 'Phone', phone: NUMBER } })).json()
      await h.database.pool.query(`update users set status = 'active', password_hash = 'hash' where id = $1`, [created.id])
      return { id: created.id as string, email }
    }
    const send = (id: string, token = h.adminToken) => h.api('POST', `/users/${id}/send-phone-code`, { token })
    const confirm = (id: string, code: string, token = h.adminToken) => h.api('POST', `/users/${id}/confirm-phone`, { token, body: { code } })
    const phoneCodes = () => h.notifications.filter((n) => n.kind === 'phone-code')

    it('sends the code by SMS to the stored number and never returns it', async () => {
      const user = await unconfirmed()

      const sent = await send(user.id)

      expect(sent.statusCode, sent.body).toBe(200)
      expect(sent.json()).toEqual({ sentTo: expect.stringMatching(/^\+49•+78$/), expiresAt: expect.any(String) })
      expect(new Date(sent.json().expiresAt).getTime()).toBeGreaterThan(Date.now())
      expect(phoneCodes().map((n) => [n.user.email, n.user.phone, n.channel])).toEqual([[user.email, NUMBER, 'sms']])
      expect(sent.body).not.toContain(h.lastPhoneCode(user.email)!)
      expect(sent.body).not.toContain(NUMBER)
      const [event] = await h.audit('user.phone.confirm.request', user.id)
      expect(event).toMatchObject({ actor_type: 'client', actor_id: 'demo-admin' })
      expect(JSON.stringify(event.details)).not.toContain(h.lastPhoneCode(user.email)!)
    })

    it('confirms the number with that code: the answer is the user, it is recorded, and the next sign-in code goes by SMS', async () => {
      const user = await unconfirmed()
      await send(user.id)
      const code = h.lastPhoneCode(user.email)!

      const confirmed = await confirm(user.id, `${code.slice(0, 3)} ${code.slice(3)}`)

      expect(confirmed.statusCode, confirmed.body).toBe(200)
      expect(confirmed.json()).toMatchObject({ id: user.id, phone: NUMBER, phoneVerifiedAt: expect.any(String) })
      expect((await h.audit('user.phone.confirm', user.id)).at(-1)).toMatchObject({ actor_type: 'client', actor_id: 'demo-admin' })
      // and once: there is nothing left to confirm
      expect((await confirm(user.id, code)).statusCode).toBe(409)
      expect((await send(user.id)).statusCode).toBe(409)
    })

    it.each([
      ['a wrong code', '000000'],
      ['something that is no code', 'abc'],
    ])('answers 422 for %s and confirms nothing', async (_name, code) => {
      const user = await unconfirmed()
      await send(user.id)
      const wrong = code === h.lastPhoneCode(user.email) ? '111111' : code

      const refused = await confirm(user.id, wrong)

      expect(refused.statusCode).toBe(422)
      expect(refused.json()).toMatchObject({ title: 'Wrong code', status: 422 })
      expect((await h.api('GET', `/users/${user.id}`)).json().phoneVerifiedAt).toBeNull()
      expect(await h.audit('user.phone.confirm', user.id)).toEqual([])
    })

    it('answers 422 when no code was sent, and 400 without a code', async () => {
      const user = await unconfirmed()
      expect((await confirm(user.id, '123456')).statusCode).toBe(422)
      expect((await h.api('POST', `/users/${user.id}/confirm-phone`, { body: {} })).statusCode).toBe(400)
    })

    it('gives a code five attempts: after that the right one is too late', async () => {
      const user = await unconfirmed()
      await send(user.id)
      const code = h.lastPhoneCode(user.email)!
      const wrong = code === '000000' ? '111111' : '000000'

      for (let attempt = 0; attempt < 5; attempt++) expect((await confirm(user.id, wrong)).statusCode).toBe(422)

      expect((await confirm(user.id, code)).statusCode).toBe(422)
      expect((await h.api('GET', `/users/${user.id}`)).json().phoneVerifiedAt).toBeNull()
    })

    it('does not send a second code right away: 429 with the time to wait', async () => {
      const user = await unconfirmed()
      await send(user.id)

      const again = await send(user.id)

      expect(again.statusCode).toBe(429)
      expect(Number(again.headers['retry-after'])).toBeGreaterThan(0)
      expect(phoneCodes()).toHaveLength(1)
    })

    it('does not confirm a number that was changed after the code was sent', async () => {
      const user = await unconfirmed()
      await send(user.id)
      const code = h.lastPhoneCode(user.email)!
      await h.api('PATCH', `/users/${user.id}`, { body: { phone: '+4915187654321' } })

      expect((await confirm(user.id, code)).statusCode).toBe(422)
      expect((await h.api('GET', `/users/${user.id}`)).json().phoneVerifiedAt).toBeNull()
    })

    it('answers 409, not a wrong code, for a user who was locked after the code was sent, and confirms nothing', async () => {
      const user = await unconfirmed()
      await send(user.id)
      const code = h.lastPhoneCode(user.email)!
      await act(user.id, 'lock')

      const refused = await confirm(user.id, code)

      expect(refused.statusCode).toBe(409)
      expect(refused.json().detail).toMatch(/user who is locked/)
      expect((await h.api('GET', `/users/${user.id}`)).json().phoneVerifiedAt).toBeNull()
      expect(await h.audit('user.phone.confirm', user.id)).toEqual([])
    })

    it('answers 503 when the SMS cannot be sent, and leaves no code to wait for', async () => {
      const user = await unconfirmed()
      h.notifier.failSms = true

      const sent = await send(user.id)

      expect(sent.statusCode).toBe(503)
      expect(sent.json().detail).toContain('No code was sent')
      expect((await h.database.pool.query(`select 1 from otp_codes where user_id = $1 and expires_at > now() + interval '5 seconds'`, [user.id])).rowCount).toBe(0)
      expect(await h.audit('user.phone.confirm.request', user.id)).toEqual([])
    })

    it.each([
      ['this pforte sends no SMS', async (_id: string) => void (h.notifier.smsAvailable = false), /sends no SMS/],
      ['the user has no number', async (id: string) => void (await h.database.pool.query(`update users set phone = null where id = $1`, [id])), /no phone number/],
      ['the number is confirmed', async (id: string) => void (await h.database.pool.query(`update users set phone_verified_at = now() where id = $1`, [id])), /confirmed already/],
      ['the user is locked', async (id: string) => void (await h.database.pool.query(`update users set status = 'locked' where id = $1`, [id])), /user who is locked/],
    ])('answers 409 and sends nothing when %s', async (_name, arrange, reason) => {
      const user = await unconfirmed()
      await arrange(user.id)

      const sent = await send(user.id)

      expect(sent.statusCode).toBe(409)
      expect(sent.json().detail).toMatch(reason)
      expect(phoneCodes()).toEqual([])
    })

    it('answers 404 for an unknown user, needs a token, and a directory client may do it', async () => {
      const user = await unconfirmed()
      expect((await send('0190f6a8-0000-7000-8000-000000000000')).statusCode).toBe(404)
      expect((await confirm('0190f6a8-0000-7000-8000-000000000000', '123456')).statusCode).toBe(404)
      expect((await h.api('POST', `/users/${user.id}/send-phone-code`, { token: null })).statusCode).toBe(401)
      expect((await h.api('POST', `/users/${user.id}/confirm-phone`, { token: null, body: { code: '123456' } })).statusCode).toBe(401)

      expect((await send(user.id, h.directoryToken)).statusCode).toBe(200)
      expect((await confirm(user.id, h.lastPhoneCode(user.email)!, h.directoryToken)).statusCode).toBe(200)
    })
  })

  describe('requests', () => {
    it.each([
      ['lock', 'locked', /lock a user who is locked/],
      ['activate', 'active', /activate a user who is active/],
    ])('refuses %s for a user who is %s, with the reason', async (action, _status, reason) => {
      const user = await seeded(action === 'lock' ? 'emma.vogel@example.com' : 'emma.vogel@example.com')
      if (action === 'lock') await act(user.id, 'lock')

      const response = await act(user.id, action)

      expect(response.statusCode).toBe(409)
      expect(response.json().detail).toMatch(reason)
      if (action === 'lock') await act(user.id, 'unlock')
    })

    it('answers 404 for an unknown user and 400 for a malformed id', async () => {
      expect((await act('0190f6a8-0000-7000-8000-000000000000', 'lock')).statusCode).toBe(404)
      expect((await act('not-a-uuid', 'lock')).statusCode).toBe(400)
    })

    it('needs a token, and a directory client may do it', async () => {
      const user = await seeded('emma.vogel@example.com')

      expect((await h.api('POST', `/users/${user.id}/end-sessions`, { token: null })).statusCode).toBe(401)
      expect((await act(user.id, 'end-sessions', h.directoryToken)).statusCode).toBe(200)
    })
  })
})
