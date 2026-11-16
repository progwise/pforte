import { Script } from 'node:vm'
import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sign, unsign } from '../interaction/signed-cookie.js'
import { NotifierUnavailableError } from '../notifications/notifier.js'
import { type AdminHarness, createAdminHarness, ISSUER } from '../test/admin-harness.js'
import { type AnswerOptions, createAuthenticator, type CreationQuestion } from '../test/authenticator.js'
import { Browser } from '../test/browser.js'
import { endSessionsDuring } from '../test/held-user.js'
import { driveSignIn } from '../test/manage-session.js'

const COOKIE_KEYS = ['k'.repeat(40)]
/** Two people of the seed. Whatever one of them sees or does must never be the other's. */
const A = { email: 'anna.schmidt@example.com' }
const B = { email: 'ben.keller@example.com' }
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'

describe.skipIf(!hasDatabase)('the account pages: passkeys', () => {
  let h: AdminHarness
  let idOfAnna: string
  const device = createAuthenticator({ origin: ISSUER })

  beforeAll(async () => {
    h = await createAdminHarness()
    idOfAnna = (await h.database.pool.query(`select id from users where email = $1`, [A.email])).rows[0].id
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(async () => {
    await h.settle()
    h.notifications.length = 0
    h.notifier.failWith = undefined
    h.backgroundErrors.length = 0
    await h.database.pool.query('delete from rate_limits')
    await h.database.pool.query('delete from otp_codes')
    await h.database.pool.query('delete from passkeys')
    await h.database.pool.query('delete from passkey_challenges')
    await h.database.pool.query(`delete from audit_events where action like 'user.passkey.%'`)
    await h.database.pool.query(`delete from oidc_payloads where account_id in (select id::text from users where email in ($1, $2))`, [A.email, B.email])
    await h.database.pool.query(`update users set status = 'active', locked_at = null, language = 'en' where email in ($1, $2)`, [A.email, B.email])
  })

  const idOf = async (email: string) => (await h.database.pool.query(`select id from users where email = $1`, [email])).rows[0].id as string
  const passkeysOf = async (email: string) => (await h.database.pool.query(`select * from passkeys where user_id = $1 order by created_at`, [await idOf(email)])).rows
  const mails = () => h.notifications.filter((notification) => notification.kind === 'passkey-added')
  /** The questions about a new passkey that pforte is waiting for an answer to. Those of the login pages are not these. */
  const open = async () => (await h.database.pool.query(`select challenge, user_id, expires_at from passkey_challenges where bound_to like 'account:%' order by created_at`)).rows

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
  const post = (browser: Browser, url: string, form: Record<string, string> = {}, userAgent = IPHONE) =>
    browser.request('POST', url, { form, headers: { 'sec-fetch-site': 'same-origin', 'user-agent': userAgent } })
  const follow = async (browser: Browser, response: { statusCode: number; headers: Record<string, unknown> }) => {
    expect(response.statusCode).toBe(303)
    return browser.request('GET', response.headers.location as string)
  }
  const unescape = (html: string) => html.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
  /** Opens the page that asks the device, and returns what the device is asked. */
  const question = async (browser: Browser) => {
    const page = await browser.request('GET', '/account/passkeys/new')
    expect(page.statusCode, page.body).toBe(200)
    return JSON.parse(unescape(/data-options="([^"]*)"/.exec(page.body)![1]!)) as CreationQuestion & Record<string, any>
  }
  /** The whole way: ask, let the device answer, post the answer. Returns the page the person lands on. */
  const add = async (browser: Browser, answer: AnswerOptions = {}) => {
    const asked = await question(browser)
    return follow(browser, await post(browser, '/account/passkeys/new', { credential: JSON.stringify(device.create(asked, answer)) }))
  }
  const rowsOf = (body: string) => body.match(/<tr><td>/g)?.length ?? 0

  describe('the list', () => {
    it('is a section of the account pages, says so when there is no passkey, and runs no script', async () => {
      const browser = await signedIn(A.email)

      const page = await browser.request('GET', '/account/passkeys')

      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('<a href="/account/passkeys" aria-current="page">Passkeys</a>')
      expect(page.body).toContain('You have no passkey.')
      expect(page.body).toContain('href="/account/passkeys/new"')
      expect(page.body).not.toContain('<script')
      expect(page.headers['content-security-policy']).not.toContain('script-src')
    })

    it('sends somebody who is not signed in to sign in', async () => {
      const page = await new Browser(h.app).request('GET', '/account/passkeys')
      expect(page.statusCode).toBe(303)
      expect(page.headers.location).toBe('/account/login?next=%2Faccount%2Fpasskeys')
    })
  })

  describe('the page that asks the device', () => {
    it('asks for a passkey that is found without a name, checks the person itself and says nothing about its make', async () => {
      const browser = await signedIn(A.email)

      const asked = await question(browser)

      expect(asked.rp).toEqual({ id: 'localhost', name: 'Example Inc.' })
      expect(asked.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' })
      expect(asked.attestation).toBe('none')
      expect(asked.user.name).toBe(A.email)
      // The passkey carries the id of the person as 16 bytes, and nothing else about them.
      expect(Buffer.from(asked.user.id, 'base64url').toString('hex')).toBe((await idOf(A.email)).replaceAll('-', ''))
      expect(asked.excludeCredentials).toEqual([])
      expect(Buffer.from(asked.challenge, 'base64url').length).toBeGreaterThanOrEqual(16)
    })

    it('asks a new question every time, and keeps it at pforte for five minutes, for that person', async () => {
      const browser = await signedIn(A.email)

      const first = await question(browser)
      const second = await question(browser)

      expect(first.challenge).not.toBe(second.challenge)
      const waiting = await open()
      expect(waiting.map((row) => row.challenge)).toEqual([first.challenge, second.challenge])
      expect(waiting.every((row) => row.user_id === idOfAnna)).toBe(true)
      const left = waiting[1].expires_at.getTime() - Date.now()
      expect(left).toBeGreaterThan(4 * 60_000)
      expect(left).toBeLessThanOrEqual(5 * 60_000)
      // Nothing about it is left with the browser.
      expect([...browser.cookies.keys()].filter((name) => /passkey/.test(name))).toEqual([])
    })

    it('may run the one script, and nothing else', async () => {
      const browser = await signedIn(A.email)

      const page = await browser.request('GET', '/account/passkeys/new')

      const { path } = h.passkeys.script
      expect(path).toMatch(/^\/assets\/passkey-[0-9a-f]{16}\.js$/)
      expect(page.headers['content-security-policy']).toBe(`${h.passkeys.script.policy}`)
      expect(page.headers['content-security-policy']).toMatch(new RegExp(`^default-src 'none'; .*; script-src https://localhost:3300${path.replaceAll('.', '\\.')}$`))
      expect(page.headers['content-security-policy']).not.toMatch(/unsafe-inline|unsafe-eval|connect-src|'self' *;? *script/)
      expect(page.body.match(/<script/g)).toHaveLength(1)
      expect(page.body).toContain(`<script src="${path}" defer></script>`)
    })

    it('works without the script: the button is disabled and the page says why', async () => {
      const browser = await signedIn(A.email)

      const page = await browser.request('GET', '/account/passkeys/new')

      expect(page.body).toContain('<button type="submit" disabled>Create passkey</button>')
      expect(page.body).toContain('<p class="error" role="alert" data-passkey-message="unsupported">This browser cannot create a passkey.</p>')
      expect(page.body).toContain('data-passkey-message="failed" hidden>')
      expect(page.body).toContain('data-passkey-message="exists" hidden>')
    })

    it('needs a sign-in that is at most five minutes old, and comes back to it', async () => {
      const browser = await signedIn(A.email)
      age(browser, 301)

      const page = await browser.request('GET', '/account/passkeys/new')

      expect(page.statusCode).toBe(303)
      expect(page.headers.location).toBe('/account/login?again=1&next=%2Faccount%2Fpasskeys%2Fnew')
      expect(await open()).toEqual([])
    })

    it('names the passkeys the person has, so a device that holds one makes no second', async () => {
      const browser = await signedIn(A.email)
      await add(browser)

      const asked = await question(browser)

      const [existing] = await passkeysOf(A.email)
      expect(asked.excludeCredentials).toEqual([{ id: existing.credential_id, type: 'public-key', transports: ['internal', 'hybrid'] }])
    })
  })

  describe('the script', () => {
    it('is served under its own address, to be kept for good, and is a script that parses', async () => {
      const { path, source } = h.passkeys.script

      const response = await h.app.inject({ method: 'GET', url: path })

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8')
      expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable')
      expect(response.headers['x-content-type-options']).toBe('nosniff')
      expect(response.body).toBe(source)
      expect(() => new Script(source)).not.toThrow()
    })

    it('talks to nobody and writes nothing into the page but what the device answered', async () => {
      const { source } = h.passkeys.script
      expect(source).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|innerHTML|document\.write|eval\(|new Function|import\(/)
    })

    it('is the only thing under that address', async () => {
      expect((await h.app.inject({ method: 'GET', url: '/assets/passkey-0000000000000000.js' })).statusCode).toBe(404)
      expect((await h.app.inject({ method: 'GET', url: '/assets/' })).statusCode).toBe(404)
    })
  })

  describe('creating one', () => {
    it('stores the passkey, lists it with the browser it was made with, and records who did it', async () => {
      const browser = await signedIn(A.email)

      const page = await add(browser, { synced: true })

      expect(page.body).toContain('The passkey was created.')
      expect(rowsOf(page.body)).toBe(1)
      expect(page.body).toContain('<td>Safari, iPhone</td>')
      expect(page.body).toContain('<td>Not yet</td>')
      const stored = await passkeysOf(A.email)
      expect(stored).toHaveLength(1)
      expect(stored[0]).toMatchObject({ label: 'Safari, iPhone', synced: true, counter: '0', transports: ['internal', 'hybrid'], last_used_at: null })
      const [event] = await h.audit('user.passkey.add', await idOf(A.email))
      expect(event).toMatchObject({ actor_type: 'user', actor_id: await idOf(A.email), user_agent: IPHONE })
      expect(event.details).toMatchObject({ email: A.email, self: true, passkeyId: stored[0].id, label: 'Safari, iPhone', synced: true })
      // The question is used up.
      expect(await open()).toEqual([])
    })

    it('tells the person by e-mail, with the page where they remove it', async () => {
      const browser = await signedIn(A.email)

      await add(browser)
      await h.settle()

      expect(mails()).toHaveLength(1)
      expect(mails()[0]).toMatchObject({ channel: 'email', device: 'Safari, iPhone', url: `${ISSUER}/account/passkeys` })
      expect(mails()[0]!.user.email).toBe(A.email)
    })

    it('keeps the passkey when the mail cannot be sent', async () => {
      const browser = await signedIn(A.email)
      h.notifier.failWith = new NotifierUnavailableError('the mail server is down')

      const page = await add(browser)
      await h.settle()

      expect(page.body).toContain('The passkey was created.')
      expect(await passkeysOf(A.email)).toHaveLength(1)
      expect(h.backgroundErrors).toEqual([])
    })

    it('lets a person have several, and shows only their own', async () => {
      const anna = await signedIn(A.email)
      const ben = await signedIn(B.email)
      await add(anna)
      await add(anna)
      await add(ben)

      expect(rowsOf((await anna.request('GET', '/account/passkeys')).body)).toBe(2)
      expect(rowsOf((await ben.request('GET', '/account/passkeys')).body)).toBe(1)
    })

    it('accepts the answer although the sign-in has turned older than five minutes meanwhile: the device has made the passkey already', async () => {
      const browser = await signedIn(A.email)
      const asked = await question(browser)
      age(browser, 301)

      const page = await follow(browser, await post(browser, '/account/passkeys/new', { credential: JSON.stringify(device.create(asked)) }))

      expect(page.body).toContain('The passkey was created.')
    })

    describe('is refused', () => {
      const refused = async (browser: Browser, response: { statusCode: number; headers: Record<string, unknown> }, message: string) => {
        const page = await follow(browser, response)
        expect(page.body).toContain(message)
        await h.settle()
        expect(await passkeysOf(A.email)).toEqual([])
        expect(mails()).toEqual([])
        expect(await h.audit('user.passkey.add', await idOf(A.email))).toEqual([])
      }
      const REJECTED = 'The answer of your device could not be checked'
      const EXPIRED = 'That took too long. Start again.'

      it.each([
        ['made on a page of another origin', { origin: 'https://localhost.example.com' }],
        ['made on pforte\'s host but another port', { origin: 'https://localhost:3301' }],
        ['made for another host', { rpId: 'example.com' }],
        ['made without the device checking the person', { userVerified: false }],
      ] satisfies [string, AnswerOptions][])('when the answer was %s', async (_name, answer) => {
        const browser = await signedIn(A.email)
        const asked = await question(browser)

        await refused(browser, await post(browser, '/account/passkeys/new', { credential: JSON.stringify(device.create(asked, answer)) }), REJECTED)
        // A wrong answer uses the question up as a right one does.
        expect(await open()).toEqual([])
      })

      it.each([
        ['nothing', {}],
        ['not JSON', { credential: 'passkey' }],
        ['JSON that is no answer', { credential: '{"id":"x","response":{}}' }],
        ['an answer that names no question', { credential: JSON.stringify({ response: { clientDataJSON: Buffer.from('{"type":"webauthn.create"}').toString('base64url') } }) }],
      ] satisfies [string, Record<string, string>][])('when what comes back is %s', async (_name, form) => {
        const browser = await signedIn(A.email)
        await question(browser)

        await refused(browser, await post(browser, '/account/passkeys/new', form), REJECTED)
      })

      it('when the answer is for a question that was never asked', async () => {
        const browser = await signedIn(A.email)
        const asked = await question(browser)
        const answer = device.create(asked, { challenge: Buffer.from('a question nobody asked').toString('base64url') })

        await refused(browser, await post(browser, '/account/passkeys/new', { credential: JSON.stringify(answer) }), EXPIRED)
      })

      it('when the question is older than five minutes', async () => {
        const browser = await signedIn(A.email)
        const asked = await question(browser)
        await h.database.pool.query(`update passkey_challenges set expires_at = now() - interval '1 second'`)

        await refused(browser, await post(browser, '/account/passkeys/new', { credential: JSON.stringify(device.create(asked)) }), EXPIRED)
      })

      it('when the question was asked of somebody else', async () => {
        const ben = await signedIn(B.email)
        const asked = await question(ben)
        const anna = await signedIn(A.email)

        await refused(anna, await post(anna, '/account/passkeys/new', { credential: JSON.stringify(device.create(asked)) }), EXPIRED)
        expect(await passkeysOf(B.email)).toEqual([])
        // Ben's question is still his to answer.
        expect((await follow(ben, await post(ben, '/account/passkeys/new', { credential: JSON.stringify(device.create(asked)) }))).body).toContain('The passkey was created.')
      })

      it('when the question was asked in another sign-in of the same person', async () => {
        const one = await signedIn(A.email)
        const asked = await question(one)
        const other = await signedIn(A.email)

        await refused(other, await post(other, '/account/passkeys/new', { credential: JSON.stringify(device.create(asked)) }), EXPIRED)
      })

      it('when the sign-in the question was asked in has ended', async () => {
        const browser = await signedIn(A.email)
        const asked = await question(browser)
        const credential = JSON.stringify(device.create(asked))
        await h.database.pool.query(`delete from oidc_payloads where account_id = $1`, [idOfAnna])

        const response = await post(browser, '/account/passkeys/new', { credential })

        expect(response.statusCode).toBe(303)
        expect(response.headers.location).toBe('/account/login')
        expect(await passkeysOf(A.email)).toEqual([])
      })
    })

    it('takes an answer once: sent again it adds nothing, also after its passkey was removed', async () => {
      const browser = await signedIn(A.email)
      const asked = await question(browser)
      const credential = JSON.stringify(device.create(asked))
      await follow(browser, await post(browser, '/account/passkeys/new', { credential }))

      expect((await follow(browser, await post(browser, '/account/passkeys/new', { credential }))).body).toContain('That took too long. Start again.')
      expect(await passkeysOf(A.email)).toHaveLength(1)

      // Removed, the passkey must stay removed: the answer that made it is worth nothing any more.
      const [passkey] = await passkeysOf(A.email)
      await follow(browser, await post(browser, '/account/passkeys/remove', { passkey: passkey.id }))
      expect((await follow(browser, await post(browser, '/account/passkeys/new', { credential }))).body).toContain('That took too long. Start again.')

      expect(await passkeysOf(A.email)).toEqual([])
      await h.settle()
      expect(mails()).toHaveLength(1)
      expect(await h.audit('user.passkey.add', idOfAnna)).toHaveLength(1)
    })

    it('takes one of two answers that arrive at the same moment', async () => {
      const browser = await signedIn(A.email)
      const asked = await question(browser)
      const credential = JSON.stringify(device.create(asked))

      const responses = await Promise.all(Array.from({ length: 5 }, () => post(browser, '/account/passkeys/new', { credential })))

      expect(responses.map((response) => response.statusCode)).toEqual([303, 303, 303, 303, 303])
      expect(await passkeysOf(A.email)).toHaveLength(1)
      await h.settle()
      expect(mails()).toHaveLength(1)
    })

    it('stores no passkey when the sessions are ended while the answer of the device is being checked', async () => {
      const browser = await signedIn(A.email)
      const asked = await question(browser)
      const credential = JSON.stringify(device.create(asked))

      const response = await endSessionsDuring(h, idOfAnna, () => post(browser, '/account/passkeys/new', { credential }))

      // The session of the account pages is over, and so is what it was about to do.
      expect(response.statusCode).toBe(303)
      expect(response.headers.location).toBe('/account/login')
      expect(await passkeysOf(A.email)).toEqual([])
      expect(await h.audit('user.passkey.add', idOfAnna)).toEqual([])
      await h.settle()
      expect(mails()).toEqual([])
    })

    it('does not store a credential that is known already, whoever has it', async () => {
      const browser = await signedIn(A.email)
      const asked = await question(browser)
      const answer = device.create(asked)
      await h.database.pool.query(`insert into passkeys (user_id, credential_id, public_key) values ($1, $2, 'key')`, [await idOf(B.email), answer.id])

      const page = await follow(browser, await post(browser, '/account/passkeys/new', { credential: JSON.stringify(answer) }))

      expect(page.body).toContain('That passkey is known already.')
      expect(await passkeysOf(A.email)).toEqual([])
      await h.settle()
      expect(mails()).toEqual([])
    })

    it('stops at twenty passkeys, before the device is asked and when its answer comes', async () => {
      const browser = await signedIn(A.email)
      const asked = await question(browser)
      const fill = (count: number) =>
        h.database.pool.query(`insert into passkeys (user_id, credential_id, public_key) select $1, 'filler-' || n, 'key' from generate_series(1, $2) n`, [idOfAnna, count])
      const idOfAnna = await idOf(A.email)
      await fill(20)

      const late = await follow(browser, await post(browser, '/account/passkeys/new', { credential: JSON.stringify(device.create(asked)) }))
      expect(late.body).toContain('An account can have 20 passkeys. Remove one first.')
      const early = await follow(browser, await browser.request('GET', '/account/passkeys/new'))
      expect(early.body).toContain('An account can have 20 passkeys. Remove one first.')
      expect(await passkeysOf(A.email)).toHaveLength(20)
    })

    it('refuses a form that another website sends', async () => {
      const browser = await signedIn(A.email)
      const asked = await question(browser)

      const response = await browser.request('POST', '/account/passkeys/new', { form: { credential: JSON.stringify(device.create(asked)) }, headers: { 'sec-fetch-site': 'cross-site' } })

      expect(response.statusCode).toBe(403)
      expect(await passkeysOf(A.email)).toEqual([])
    })
  })

  describe('removing one', () => {
    it('removes it, so that it is not listed any more, and records who did it', async () => {
      const browser = await signedIn(A.email)
      await add(browser)
      await add(browser)
      const [first, second] = await passkeysOf(A.email)

      const page = await follow(browser, await post(browser, '/account/passkeys/remove', { passkey: first.id }))

      expect(page.body).toContain('The passkey was removed and cannot sign in any more.')
      expect(rowsOf(page.body)).toBe(1)
      expect((await passkeysOf(A.email)).map((row) => row.id)).toEqual([second.id])
      const [event] = await h.audit('user.passkey.remove', await idOf(A.email))
      expect(event).toMatchObject({ actor_type: 'user', actor_id: await idOf(A.email) })
      expect(event.details).toMatchObject({ self: true, passkeyId: first.id, label: 'Safari, iPhone' })
    })

    it('needs a sign-in that is at most five minutes old', async () => {
      const browser = await signedIn(A.email)
      await add(browser)
      const [passkey] = await passkeysOf(A.email)
      age(browser, 301)

      const response = await post(browser, '/account/passkeys/remove', { passkey: passkey.id })

      expect(response.statusCode).toBe(303)
      expect(response.headers.location).toBe('/account/login?again=1&next=%2Faccount%2Fpasskeys')
      expect(await passkeysOf(A.email)).toHaveLength(1)
    })

    it('does not touch the passkey of somebody else: it is "gone", like one that never was', async () => {
      const ben = await signedIn(B.email)
      await add(ben)
      const [bens] = await passkeysOf(B.email)
      const anna = await signedIn(A.email)

      for (const passkey of [bens.id, '018f0000-0000-7000-8000-000000000000', 'not-an-id', '']) {
        const page = await follow(anna, await post(anna, '/account/passkeys/remove', { passkey }))
        expect(page.body).toContain('That passkey does not exist any more.')
      }

      expect(await passkeysOf(B.email)).toHaveLength(1)
      expect(await h.audit('user.passkey.remove', await idOf(B.email))).toEqual([])
    })
  })

  it('speaks the language of the person', async () => {
    await h.database.pool.query(`update users set language = 'de' where email = $1`, [A.email])
    const browser = await signedIn(A.email)

    expect((await browser.request('GET', '/account/passkeys')).body).toContain('Sie haben keinen Passkey.')
    expect((await browser.request('GET', '/account/passkeys/new')).body).toContain('<button type="submit" disabled>Passkey erstellen</button>')
  })
})
