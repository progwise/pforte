import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NotifierUnavailableError } from '../notifications/notifier.js'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { Browser, signIn, verifyJwt } from '../test/browser.js'

const WEB = { clientId: 'demo-web', redirectUri: 'http://localhost:3400/callback' }
const GOOD = 'correct horse battery'

describe.skipIf(!hasDatabase)('activation and password reset pages', () => {
  let h: AdminHarness
  let counter = 0

  beforeAll(async () => {
    h = await createAdminHarness()
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(() => {
    h.notifications.length = 0
    h.notifier.failWith = undefined
    h.notifier.failSms = false
    h.notifier.smsAvailable = false
  })

  const browser = () => new Browser(h.app)
  const form = (method: 'GET' | 'POST', url: string, fields?: Record<string, string>) => browser().request(method, url, fields ? { form: fields } : {})
  const row = async (email: string) => (await h.database.pool.query(`select * from users where email = $1`, [email])).rows[0]
  /** The page with the address left out, so pages for different addresses can be compared. */
  const anonymous = (body: string, email: string) => body.replaceAll(encodeURIComponent(email), 'EMAIL').replaceAll(email, 'EMAIL')
  const tokenOf = (url: string) => new URL(url).searchParams.get('token')!

  /** A created user with an activation link: what an administrator and the mail would produce. */
  const invited = async () => {
    const email = `account${++counter}@example.com`
    const created = (await h.api('POST', '/users', { body: { email, firstName: 'Ada', lastName: 'Lovelace' } })).json()
    const activate = await h.api('POST', `/users/${created.id}/activate`)
    expect(activate.statusCode, activate.body).toBe(200)
    const token = tokenOf(h.notifications.findLast((n) => n.kind === 'activation')!.url!)
    h.notifications.length = 0
    return { email, id: created.id as string, token }
  }

  /** A user who has activated the account with a password. */
  const activated = async (password = GOOD) => {
    const user = await invited()
    const done = await form('POST', '/activate', { token: user.token, password, confirm: password })
    expect(done.statusCode, done.body).toBe(200)
    h.notifications.length = 0
    return { ...user, password }
  }

  /** Asks for a reset and waits for the mail to be sent, which happens after the answer. */
  const requestReset = async (email: string) => {
    const response = await form('POST', '/reset', { email })
    await h.settle()
    return response
  }
  const resetCode = (email: string) => h.lastResetCode(email)!
  const submitReset = (email: string, code: string, password = 'a brand new password', confirm = password) =>
    form('POST', '/reset/code', { email, code, password, confirm })

  describe('activation', () => {
    it('shows the form for a valid link and refuses anything else', async () => {
      const { token } = await invited()
      const page = await form('GET', `/activate?token=${token}`)
      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('Choose your password')
      expect(page.body).toContain(`name="token" value="${token}"`)

      expect((await form('GET', '/activate')).statusCode).toBe(400)
      expect((await form('GET', '/activate?token=nonsense')).statusCode).toBe(400)
    })

    it('does not cache the page or send the link along as referrer', async () => {
      const { token } = await invited()
      const page = await form('GET', `/activate?token=${token}`)
      expect(page.headers['referrer-policy']).toBe('no-referrer')
      expect(page.headers['cache-control']).toBe('no-store')
      expect(page.headers['content-security-policy']).toContain("default-src 'none'")
    })

    it('sets the first password, activates, verifies the e-mail, and lets the user sign in', async () => {
      const { email, token } = await invited()
      const done = await form('POST', '/activate', { token, password: GOOD, confirm: GOOD })

      expect(done.statusCode).toBe(200)
      expect(done.body).toContain('Your account is active')
      const user = await row(email)
      expect(user).toMatchObject({ status: 'active', activation_token_hash: null })
      expect(user.email_verified_at).not.toBeNull()
      expect(user.password_hash).toMatch(/^\$argon2/)
      expect(user.password_hash).not.toContain(GOOD)

      const signedIn = await signIn(new Browser(h.app), { ...WEB, email, password: GOOD })
      expect(signedIn.code).toBeTruthy()
    })

    it('keeps the link usable after a mistake, and says what is wrong', async () => {
      const { email, token } = await invited()
      const short = await form('POST', '/activate', { token, password: 'short', confirm: 'short' })
      expect(short.statusCode).toBe(422)
      expect(short.body).toContain('at least 10 characters')

      const different = await form('POST', '/activate', { token, password: GOOD, confirm: `${GOOD}!` })
      expect(different.statusCode).toBe(422)
      expect(different.body).toContain('not the same')

      const likeEmail = await form('POST', '/activate', { token, password: email, confirm: email })
      expect(likeEmail.body).toContain('must not be your e-mail address')

      expect((await form('POST', '/activate', { token, password: GOOD, confirm: GOOD })).statusCode).toBe(200)
    })

    it('works once', async () => {
      const { token } = await invited()
      await form('POST', '/activate', { token, password: GOOD, confirm: GOOD })
      const again = await form('POST', '/activate', { token, password: 'another long password', confirm: 'another long password' })
      expect(again.statusCode).toBe(400)
      expect((await form('GET', `/activate?token=${token}`)).statusCode).toBe(400)
    })

    it('refuses an expired link, and a link replaced by a newer one', async () => {
      const expired = await invited()
      await h.database.pool.query(`update users set activation_expires_at = now() - interval '1 minute' where id = $1`, [expired.id])
      expect((await form('POST', '/activate', { token: expired.token, password: GOOD, confirm: GOOD })).statusCode).toBe(400)

      const replaced = await invited()
      await h.api('POST', `/users/${replaced.id}/activate`)
      expect((await form('GET', `/activate?token=${replaced.token}`)).statusCode).toBe(400)
    })

    it('refuses the link of a user who was deactivated meanwhile', async () => {
      const { id, token } = await invited()
      await h.api('POST', `/users/${id}/deactivate`)
      expect((await form('GET', `/activate?token=${token}`)).statusCode).toBe(400)
    })

    it('records who activated, without the password or the token', async () => {
      const { id, token } = await invited()
      await form('POST', '/activate', { token, password: GOOD, confirm: GOOD })
      const events = await h.audit('user.activate.complete', id)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ actor_type: 'user', actor_id: id })
      expect(JSON.stringify(events[0])).not.toContain(GOOD)
      expect(JSON.stringify(events[0])).not.toContain(token)
    })
  })

  describe('continuing to the application', () => {
    const BUTTON = 'Continue to Demo web app (public client)'

    /** A created user whose invitation named the client. */
    const invitedTo = async (clientId?: string) => {
      const email = `account${++counter}@example.com`
      const created = (await h.api('POST', '/users', { body: { email, firstName: 'Ada', lastName: 'Lovelace' } })).json()
      const activate = await h.api('POST', `/users/${created.id}/activate`, { body: clientId ? { clientId } : undefined })
      expect(activate.statusCode, activate.body).toBe(200)
      const token = tokenOf(h.notifications.findLast((n) => n.kind === 'activation')!.url!)
      h.notifications.length = 0
      return { email, id: created.id as string, token }
    }

    it('leads on to the start address of the client the person was invited to', async () => {
      const user = await invitedTo('demo-web')
      const done = await form('POST', '/activate', { token: user.token, password: GOOD, confirm: GOOD })
      expect(done.statusCode).toBe(200)
      expect(done.body).toContain(BUTTON)
      expect(done.body).toContain('href="http://localhost:3400/"')
    })

    it('shows no button without a client, or when the client has no start address', async () => {
      const plain = await invitedTo()
      expect((await form('POST', '/activate', { token: plain.token, password: GOOD, confirm: GOOD })).body).not.toContain('Continue to')

      await h.api('POST', '/clients', { body: { clientId: 'no-start-app', name: 'No start', type: 'public', redirectUris: ['https://nostart.example.com/cb'] } })
      const user = await invitedTo('no-start-app')
      const done = await form('POST', '/activate', { token: user.token, password: GOOD, confirm: GOOD })
      expect(done.statusCode).toBe(200)
      expect(done.body).not.toContain('Continue to')
    })

    it('shows no button when the client was deleted after the invitation', async () => {
      await h.api('POST', '/clients', { body: { clientId: 'gone-app', name: 'Gone', type: 'public', redirectUris: ['https://gone.example.com/cb'], clientUri: 'https://gone.example.com/' } })
      const user = await invitedTo('gone-app')
      await h.api('DELETE', '/clients/gone-app')
      const done = await form('POST', '/activate', { token: user.token, password: GOOD, confirm: GOOD })
      expect(done.statusCode).toBe(200)
      expect(done.body).not.toContain('Continue to')
    })

    it('speaks the language of the person on the button', async () => {
      const user = await invitedTo('demo-web')
      await h.database.pool.query(`update users set language = 'de' where id = $1`, [user.id])
      const done = await form('POST', '/activate', { token: user.token, password: GOOD, confirm: GOOD })
      expect(done.body).toContain('Weiter zu Demo web app (public client)')
    })

    it('keeps the client through the confirmation of the phone number', async () => {
      h.notifier.smsAvailable = true
      const user = await invitedTo('demo-web')
      await h.database.pool.query(`update users set phone = '+4915112345678' where id = $1`, [user.id])
      const password = await form('POST', '/activate', { token: user.token, password: GOOD, confirm: GOOD })
      expect(password.body).toContain('action="/activate/phone"')
      expect(password.body).not.toContain('Continue to')

      const cookie = String(password.headers['set-cookie']).split(';')[0]!
      const skipped = await browser().request('POST', '/activate/phone/skip', { headers: { cookie } })
      expect(skipped.body).toContain(BUTTON)

      const confirmed = await browser().request('POST', '/activate/phone', { form: { code: h.lastPhoneCode(user.email)! }, headers: { cookie } })
      expect(confirmed.body).toContain(BUTTON)
    })

    it('carries the client from the sign-in page through the reset, and ends with the button', async () => {
      const user = await activated()
      const b = browser()
      const authorize = await b.request('GET', '/auth?client_id=demo-web&redirect_uri=http%3A%2F%2Flocalhost%3A3400%2Fcallback&response_type=code&scope=openid&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256')
      const login = await b.request('GET', authorize.headers.location as string)
      expect(login.body).toContain('href="/reset?lang=en&amp;client_id=demo-web"')

      const ask = await form('GET', '/reset?lang=en&client_id=demo-web')
      expect(ask.body).toContain('name="client_id" value="demo-web"')
      const sent = await form('POST', '/reset', { email: user.email, client_id: 'demo-web' })
      await h.settle()
      expect(sent.body).toContain('name="client_id" value="demo-web"')

      const done = await form('POST', '/reset/code', { email: user.email, code: resetCode(user.email), password: 'a brand new password', confirm: 'a brand new password', client_id: 'demo-web' })
      expect(done.statusCode).toBe(200)
      expect(done.body).toContain(BUTTON)
      expect(done.body).toContain('href="http://localhost:3400/"')
    })

    it('shows no button after a reset without a client, or for a client that does not exist', async () => {
      for (const client_id of [undefined, 'nobody', 'https://evil.example/']) {
        const user = await activated()
        await requestReset(user.email)
        const done = await form('POST', '/reset/code', {
          email: user.email,
          code: resetCode(user.email),
          password: 'a brand new password',
          confirm: 'a brand new password',
          ...(client_id ? { client_id } : {}),
        })
        expect(done.statusCode).toBe(200)
        expect(done.body).not.toContain('Continue to')
        expect(done.body).not.toContain('evil.example')
      }
    })
  })

  describe('forgotten password', () => {
    it('is linked from the login page', async () => {
      const b = browser()
      const authorize = await b.request('GET', '/auth?client_id=demo-web&redirect_uri=http%3A%2F%2Flocalhost%3A3400%2Fcallback&response_type=code&scope=openid&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256')
      const page = await b.request('GET', authorize.headers.location as string)
      expect(page.body).toContain('href="/reset?lang=en&amp;client_id=demo-web"')
      expect((await form('GET', '/reset')).body).toContain('Set or reset your password')
    })

    it('sends a code to a user who can sign in, and says the same to everyone else', async () => {
      const user = await activated()
      const known = await requestReset(user.email)
      expect(h.notifications).toEqual([expect.objectContaining({ kind: 'reset-code', user: expect.objectContaining({ email: user.email }) })])
      expect(resetCode(user.email)).toMatch(/^\d{6}$/)

      const locked = await activated()
      await h.api('POST', `/users/${locked.id}/lock`)
      const deactivated = await activated()
      await h.api('POST', `/users/${deactivated.id}/deactivate`)
      h.notifications.length = 0

      const answers = await Promise.all(
        ['nobody@example.com', locked.email, deactivated.email].map(async (email) => ({ email, response: await requestReset(email) })),
      )
      expect(h.notifications).toEqual([])
      for (const { email, response } of answers) {
        expect(response.statusCode).toBe(200)
        expect(anonymous(response.body, email)).toBe(anonymous(known.body, user.email))
      }
    })

    describe('a person without a password asks for their activation link', () => {
      it('gets a new link that replaces the earlier one, and answers like for everyone else', async () => {
        const person = await invited()
        const active = await activated()
        const known = await requestReset(active.email)
        h.notifications.length = 0

        const response = await requestReset(person.email)
        expect(anonymous(response.body, person.email)).toBe(anonymous(known.body, active.email))
        const mail = h.notifications.filter((n) => n.kind === 'activation')
        expect(mail).toEqual([expect.objectContaining({ user: expect.objectContaining({ email: person.email }) })])
        expect(h.notifications.filter((n) => n.kind === 'reset-code')).toEqual([])

        const fresh = tokenOf(mail[0]!.url!)
        expect(fresh).not.toBe(person.token)
        expect((await form('GET', `/activate?token=${person.token}`)).statusCode).not.toBe(200)
        const done = await form('POST', '/activate', { token: fresh, password: GOOD, confirm: GOOD })
        expect(done.statusCode, done.body).toBe(200)
        expect((await row(person.email)).status).toBe('active')
      })

      it('is recorded as a request of the person themselves, without the link', async () => {
        const person = await invited()
        await requestReset(person.email)
        const events = await h.audit('user.activation.request', person.id)
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({ actor_type: 'user', actor_id: person.id })
        expect(events[0].details).toMatchObject({ self: true })
        expect(JSON.stringify(events[0])).not.toContain(h.notifications.findLast((n) => n.kind === 'activation')!.url!.split('token=')[1])
      })

      it('answers before it sends, like the reset code does', async () => {
        const person = await invited()
        let release!: () => void
        h.notifier.hold = new Promise<void>((resolve) => (release = resolve))
        const response = await form('POST', '/reset', { email: person.email })
        expect(response.statusCode).toBe(200)
        expect(h.notifications).toEqual([])
        release()
        h.notifier.hold = undefined
        await h.settle()
        expect(h.notifications).toEqual([expect.objectContaining({ kind: 'activation' })])
        expect(h.backgroundErrors).toEqual([])
      })

      it('does not reveal a failure to send', async () => {
        const person = await invited()
        h.notifier.failWith = new NotifierUnavailableError('SMTP is down')
        const response = await requestReset(person.email)
        expect(response.statusCode).toBe(200)
        expect(response.body).not.toContain('SMTP')
        expect(h.backgroundErrors).toEqual([])
      })

      it('gives nothing to a locked or deactivated person who has no password', async () => {
        const locked = await invited()
        await h.api('POST', `/users/${locked.id}/lock`)
        const deactivated = await invited()
        await h.api('POST', `/users/${deactivated.id}/deactivate`)
        h.notifications.length = 0
        await requestReset(locked.email)
        await requestReset(deactivated.email)
        expect(h.notifications).toEqual([])
      })
    })

    it('does not reveal a failure to send, and does not send twice within a minute', async () => {
      const user = await activated()
      h.notifier.failWith = new NotifierUnavailableError('SMTP is down')
      const failed = await requestReset(user.email)
      expect(failed.statusCode).toBe(200)
      expect(failed.body).not.toContain('SMTP')
      h.notifier.failWith = undefined

      expect((await requestReset(user.email)).statusCode).toBe(200)
      // the failed attempt left a code behind, so the second request is within the cooldown
      expect(h.notifications).toEqual([])
    })

    it('answers before it looks for the account or sends anything, so the time says nothing about the account', async () => {
      const user = await activated()
      let release!: () => void
      h.notifier.hold = new Promise<void>((resolve) => (release = resolve))

      // the mail is held back, yet both requests are answered: the answer does not wait for it
      const known = await form('POST', '/reset', { email: user.email })
      const unknown = await form('POST', '/reset', { email: 'nobody@example.com' })
      expect(known.statusCode).toBe(200)
      expect(unknown.statusCode).toBe(200)
      expect(h.notifications).toEqual([])

      release()
      h.notifier.hold = undefined
      await h.settle()
      expect(h.notifications).toEqual([expect.objectContaining({ kind: 'reset-code', user: expect.objectContaining({ email: user.email }) })])
      expect(h.backgroundErrors).toEqual([])
    })

    it('rejects a request without an e-mail address', async () => {
      expect((await form('POST', '/reset', { email: '' })).statusCode).toBe(400)
    })

    it('changes the password with the code: old password stops, new one works, everything signs out', async () => {
      const user = await activated()
      const remembered = browser()
      const first = await signIn(remembered, { ...WEB, email: user.email, password: user.password })
      expect(first.code).toBeTruthy()
      await requestReset(user.email)

      const done = await submitReset(user.email, resetCode(user.email), 'a brand new password')
      expect(done.statusCode).toBe(200)
      expect(done.body).toContain('Password changed')

      const old = await signIn(browser(), { ...WEB, email: user.email, password: user.password })
      expect(old.login.statusCode).toBe(401)
      const fresh = await signIn(browser(), { ...WEB, email: user.email, password: 'a brand new password' })
      expect(fresh.code).toBeTruthy()

      const events = await h.audit('user.password_reset.complete', user.id)
      expect(events).toHaveLength(1)
      expect(events[0].details.sessionsEnded).toBeGreaterThan(0)
      expect(JSON.stringify(events[0])).not.toContain('brand new')
    })

    it('ends the sessions and forgets the remembered devices', async () => {
      const user = await activated()
      const b = browser()
      await signIn(b, { ...WEB, email: user.email, password: user.password })
      await h.database.pool.query(
        `insert into devices (user_id, token_hash, expires_at) values ($1, 'x', now() + interval '1 day')`,
        [user.id],
      )
      await requestReset(user.email)
      await submitReset(user.email, resetCode(user.email))

      expect((await h.database.pool.query(`select count(*) from oidc_payloads where account_id = $1`, [user.id])).rows[0].count).toBe('0')
      expect((await h.database.pool.query(`select count(*) from devices where user_id = $1 and revoked_at is null`, [user.id])).rows[0].count).toBe('0')
    })

    it('verifies the e-mail address, since the code came by e-mail', async () => {
      const user = await activated()
      await h.database.pool.query(`update users set email_verified_at = null where id = $1`, [user.id])
      await requestReset(user.email)
      await submitReset(user.email, resetCode(user.email))
      expect((await row(user.email)).email_verified_at).not.toBeNull()
    })

    it('uses a code once, and refuses wrong codes without saying why', async () => {
      const user = await activated()
      await requestReset(user.email)
      const code = resetCode(user.email)
      const wrong = code === '000000' ? '000001' : '000000'

      const refused = await submitReset(user.email, wrong)
      expect(refused.statusCode).toBe(401)
      expect(refused.body).toContain('not correct or has expired')
      const unknown = await submitReset('nobody@example.com', wrong)
      expect(unknown.statusCode).toBe(401)
      expect(anonymous(unknown.body, 'nobody@example.com')).toBe(anonymous(refused.body, user.email))

      expect((await submitReset(user.email, code)).statusCode).toBe(200)
      expect((await submitReset(user.email, code, 'yet another password')).statusCode).toBe(401)
    })

    it('invalidates the code at the sixth attempt', async () => {
      const user = await activated()
      await requestReset(user.email)
      const code = resetCode(user.email)
      const wrong = code === '000000' ? '000001' : '000000'
      for (let attempt = 0; attempt < 5; attempt++) expect((await submitReset(user.email, wrong)).statusCode).toBe(401)
      expect((await submitReset(user.email, code)).statusCode).toBe(401)
    })

    it('does not use up an attempt when the new password is not acceptable', async () => {
      const user = await activated()
      await requestReset(user.email)
      const code = resetCode(user.email)
      for (let attempt = 0; attempt < 8; attempt++) {
        expect((await submitReset(user.email, code, 'short')).statusCode).toBe(422)
      }
      expect((await submitReset(user.email, code, 'now a good password')).statusCode).toBe(200)
    })

    it('does not accept the code of a sign-in, nor use a reset code to sign in', async () => {
      const user = await activated()
      const b = browser()
      await signIn(b, { ...WEB, email: user.email, password: user.password })
      const loginCode = h.notifications.findLast((n) => n.kind === 'login-code')!.code!
      await requestReset(user.email)
      expect((await submitReset(user.email, loginCode)).statusCode).toBe(401)

      const attempt = await signIn(browser(), { ...WEB, email: user.email, password: user.password, stopAtCode: true })
      expect(attempt.codePage).toBeDefined()
    })

    it('lets an administrator start a reset: the mail links to the page that takes the code', async () => {
      const user = await activated()
      const response = await h.api('POST', `/users/${user.id}/reset-password`)
      expect(response.statusCode).toBe(200)

      const mail = h.notifications.findLast((n) => n.kind === 'reset-code')!
      expect(mail.url).toBe(`https://localhost:3300/reset/code?email=${encodeURIComponent(user.email)}&lang=en`)
      const page = await form('GET', `/reset/code?email=${encodeURIComponent(user.email)}`)
      expect(page.body).toContain(`name="email" value="${user.email}"`)
      expect((await submitReset(user.email, mail.code!)).statusCode).toBe(200)

      const again = await h.api('POST', `/users/${user.id}/reset-password`)
      expect(again.statusCode).toBe(200)
    })

    it('tells an administrator when codes were requested too often', async () => {
      const user = await activated()
      expect((await h.api('POST', `/users/${user.id}/reset-password`)).statusCode).toBe(200)
      const second = await h.api('POST', `/users/${user.id}/reset-password`)
      expect(second.statusCode).toBe(429)
      expect(Number(second.headers['retry-after'])).toBeGreaterThan(0)
      expect(second.json().detail).toContain('saved')
    })

    it('has the claims of a user who reset their password intact', async () => {
      const user = await activated()
      await requestReset(user.email)
      await submitReset(user.email, resetCode(user.email))
      const signedIn = await signIn(browser(), { ...WEB, email: user.email, password: 'a brand new password' })
      const b = browser()
      const result = await signIn(b, { ...WEB, email: user.email, password: 'a brand new password' })
      const tokens = (
        await b.request('POST', '/token', {
          form: { grant_type: 'authorization_code', code: result.code!, redirect_uri: WEB.redirectUri, client_id: WEB.clientId, code_verifier: result.verifier },
        })
      ).json()
      expect(signedIn.code).toBeTruthy()
      expect((await verifyJwt(h.app, tokens.id_token)).claims).toMatchObject({ email: user.email, email_verified: true })
    })
  })

  describe('with SMS', () => {
    const NUMBER = '+4915112345678'

    /** A user with a phone number, invited by an administrator. */
    const invitedWithPhone = async () => {
      const email = `phone${++counter}@example.com`
      const created = (await h.api('POST', '/users', { body: { email, firstName: 'Pia', lastName: 'Phone', phone: NUMBER } })).json()
      await h.api('POST', `/users/${created.id}/activate`)
      const token = tokenOf(h.notifications.findLast((n) => n.kind === 'activation')!.url!)
      h.notifications.length = 0
      return { email, id: created.id as string, token }
    }
    const activateWith = (token: string) => browser().request('POST', '/activate', { form: { token, password: GOOD, confirm: GOOD } })
    const cookieOf = (response: Awaited<ReturnType<typeof activateWith>>) =>
      [response.headers['set-cookie']].flat().find((header) => header?.startsWith('pforte_phone_step='))?.split(';')[0]

    it('confirms the phone number after the password, and uses it for the codes from then on', async () => {
      h.notifier.smsAvailable = true
      const user = await invitedWithPhone()
      const done = await activateWith(user.token)

      expect(done.body).toContain('Confirm your phone number')
      expect(done.body).not.toContain(NUMBER)
      expect(h.notifications).toEqual([expect.objectContaining({ kind: 'phone-code', channel: 'sms' })])
      const cookie = cookieOf(done)!
      expect(cookie).toBeDefined()
      expect([done.headers['set-cookie']].flat().join()).toMatch(/pforte_phone_step=[^;]+; Path=\/activate; .*HttpOnly; SameSite=Strict/)

      const wrong = await browser().request('POST', '/activate/phone', { form: { code: '000000' }, headers: { cookie } })
      expect(wrong.statusCode).toBe(401)
      const right = await browser().request('POST', '/activate/phone', { form: { code: h.lastPhoneCode(user.email)! }, headers: { cookie } })
      expect(right.statusCode).toBe(200)
      expect(right.body).toContain('Phone number confirmed')
      expect((await row(user.email)).phone_verified_at).not.toBeNull()

      h.notifications.length = 0
      await signIn(browser(), { ...WEB, email: user.email, password: GOOD })
      expect(h.notifications.findLast((n) => n.kind === 'login-code')).toMatchObject({ channel: 'sms' })
    })

    it('lets the user skip the confirmation: the account works, the codes come by e-mail', async () => {
      h.notifier.smsAvailable = true
      const user = await invitedWithPhone()
      const cookie = cookieOf(await activateWith(user.token))!
      const skipped = await browser().request('POST', '/activate/phone/skip', { headers: { cookie } })
      expect(skipped.statusCode).toBe(200)
      expect(skipped.body).toContain('Your account is active')

      expect((await row(user.email)).phone_verified_at).toBeNull()
      h.notifications.length = 0
      await signIn(browser(), { ...WEB, email: user.email, password: GOOD })
      expect(h.notifications.findLast((n) => n.kind === 'login-code')).toMatchObject({ channel: 'email' })
    })

    it('does not ask when SMS is not available, or when there is no number', async () => {
      const without = await invitedWithPhone()
      expect((await activateWith(without.token)).body).toContain('Your account is active')
      expect(h.notifications).toEqual([])

      h.notifier.smsAvailable = true
      const noNumber = await invited()
      expect((await activateWith(noNumber.token)).body).toContain('Your account is active')
    })

    it('stays active when the confirmation SMS cannot be sent', async () => {
      h.notifier.smsAvailable = true
      h.notifier.failSms = true
      const user = await invitedWithPhone()
      const done = await activateWith(user.token)
      expect(done.statusCode).toBe(200)
      expect(done.body).toContain('Your account is active')
      expect((await row(user.email)).status).toBe('active')
    })

    it('needs the cookie of the step, and cannot be used for somebody else', async () => {
      h.notifier.smsAvailable = true
      const user = await invitedWithPhone()
      await activateWith(user.token)
      const code = h.lastPhoneCode(user.email)!

      const noCookie = await browser().request('POST', '/activate/phone', { form: { code } })
      expect(noCookie.body).toContain('Your account is active')
      expect((await row(user.email)).phone_verified_at).toBeNull()

      const forged = await browser().request('POST', '/activate/phone', { form: { code }, headers: { cookie: 'pforte_phone_step=e30.forged' } })
      expect(forged.body).toContain('Your account is active')
      expect((await row(user.email)).phone_verified_at).toBeNull()
    })

    it('waits before sending another confirmation code', async () => {
      h.notifier.smsAvailable = true
      const user = await invitedWithPhone()
      const cookie = cookieOf(await activateWith(user.token))!
      const again = await browser().request('POST', '/activate/phone/resend', { headers: { cookie } })
      expect(again.statusCode).toBe(429)
      expect(again.body).toContain('Please wait')
    })

    it('sends the password reset code by SMS to a confirmed number, otherwise by e-mail', async () => {
      h.notifier.smsAvailable = true
      const confirmed = await activated()
      await h.database.pool.query(`update users set phone = $2, phone_verified_at = now() where id = $1`, [confirmed.id, NUMBER])
      await requestReset(confirmed.email)
      expect(h.notifications.findLast((n) => n.kind === 'reset-code')).toMatchObject({ channel: 'sms' })
      expect((await submitReset(confirmed.email, resetCode(confirmed.email))).statusCode).toBe(200)

      const unconfirmed = await activated()
      await h.database.pool.query(`update users set phone = $2 where id = $1`, [unconfirmed.id, NUMBER])
      h.notifications.length = 0
      await requestReset(unconfirmed.email)
      expect(h.notifications.findLast((n) => n.kind === 'reset-code')).toMatchObject({ channel: 'email' })
    })

    it('does not mark the e-mail verified when the reset code came by SMS', async () => {
      h.notifier.smsAvailable = true
      const user = await activated()
      await h.database.pool.query(`update users set phone = $2, phone_verified_at = now(), email_verified_at = null where id = $1`, [user.id, NUMBER])
      await requestReset(user.email)
      await submitReset(user.email, resetCode(user.email))
      expect((await row(user.email)).email_verified_at).toBeNull()
    })
  })
})


describe.skipIf(!hasDatabase)('activation by request, switched off', () => {
  let h: AdminHarness

  beforeAll(async () => {
    h = await createAdminHarness({ selfServiceActivation: false })
  })

  afterAll(async () => {
    await h?.close()
  })

  it('sends nothing to a person without a password, and still answers the same', async () => {
    const email = 'invited-only@example.com'
    expect((await h.api('POST', '/users', { body: { email, firstName: 'Ada', lastName: 'Lovelace' } })).statusCode).toBe(201)
    const browser = () => new Browser(h.app)
    const response = await browser().request('POST', '/reset', { form: { email } })
    await h.settle()
    expect(response.statusCode).toBe(200)
    expect(h.notifications).toEqual([])
  })
})
