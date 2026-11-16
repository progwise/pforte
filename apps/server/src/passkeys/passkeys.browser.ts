import { createServer } from 'node:net'
import { hasDatabase } from '@progwise/pforte-db/testing'
import { type Browser, type BrowserContext, type CDPSession, chromium, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'

/**
 * The script of the passkey pages, in the browser it is written for: Chrome with its virtual authenticator, a
 * device in software that the browser itself asks. Everything the server does with the answer is tested without a
 * browser (`passkey-pages.test.ts`); this is about the half that only a browser can run.
 */

const EMAIL = 'anna.schmidt@example.com'

/** A port nobody listens on. pforte has to know its own address before it starts. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, 'localhost', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

describe.skipIf(!hasDatabase)('passkeys in a real browser', () => {
  let h: AdminHarness
  let origin: string
  let chrome: Browser
  let context: BrowserContext
  let page: Page
  let devtools: CDPSession
  let authenticatorId: string
  /** What the browser complained about: a script that was blocked, an error in the script. */
  let complaints: string[]

  beforeAll(async () => {
    const port = await freePort()
    origin = `http://localhost:${port}`
    h = await createAdminHarness({ issuer: origin })
    await h.app.listen({ port, host: 'localhost' })
    chrome = await chromium.launch({ channel: 'chrome' })
  })

  afterAll(async () => {
    await chrome?.close()
    await h?.close()
  })

  /**
   * Signs the person in to their account pages, as they would: password, then the code from the mail. On a
   * device that can make a passkey the offer follows the code; `offer` says what the person does with it.
   */
  const signIn = async (target: Page, offer: 'not now' | 'create' | 'stop' = 'not now') => {
    await target.goto(`${origin}/account`)
    await target.fill('#email', EMAIL)
    await target.fill('#password', 'dev-password')
    await target.click('form[action$="/login"] button[type="submit"]')
    await target.waitForURL(/\/interaction\/[^/]+\/code$/)
    await target.fill('#code', h.notifications.findLast((notification) => notification.kind === 'login-code' && notification.user.email === EMAIL)!.code!)
    await target.click('form[action$="/code"] button[type="submit"]')
    await target.waitForURL((url) => url.pathname === '/account' || url.pathname.endsWith('/passkey-offer'))
    if (!target.url().endsWith('/passkey-offer') || offer === 'stop') return
    if (offer === 'create') await target.click('form[data-passkey="create"] button[type="submit"]')
    else await target.click('form[action$="/passkey-offer/skip"] button')
    await target.waitForURL(`${origin}/account`)
  }
  const watch = (target: Page) => {
    target.on('console', (message) => {
      if (message.type() === 'error') complaints.push(message.text())
    })
    target.on('pageerror', (error) => complaints.push(String(error)))
  }
  /** Gives the browser a device that holds passkeys and checks the person, as a phone does. */
  const addDevice = async (session: CDPSession, { userVerified = true } = {}) => {
    await session.send('WebAuthn.enable')
    const { authenticatorId: id } = await session.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: userVerified, automaticPresenceSimulation: true },
    })
    return id
  }
  const stored = async () => (await h.database.pool.query(`select p.* from passkeys p join users u on u.id = p.user_id where u.email = $1 order by p.created_at`, [EMAIL])).rows

  beforeEach(async () => {
    await h.settle()
    h.notifications.length = 0
    await h.database.pool.query('delete from rate_limits')
    await h.database.pool.query('delete from otp_codes')
    await h.database.pool.query('delete from passkeys')
    await h.database.pool.query(`update users set language = 'en' where email = $1`, [EMAIL])
    complaints = []
    context = await chrome.newContext()
    page = await context.newPage()
    watch(page)
    devtools = await context.newCDPSession(page)
    authenticatorId = await addDevice(devtools)
    await signIn(page)
  })

  afterEach(async () => {
    await context?.close()
  })

  it('creates a passkey on the device and stores its public half', async () => {
    await page.goto(`${origin}/account/passkeys`)
    await page.click('a[href="/account/passkeys/new"]')
    // The script has run: the button is enabled and the hint that this browser cannot do it is gone.
    await expect.poll(() => page.isEnabled('form[data-passkey] button[type="submit"]')).toBe(true)
    expect(await page.isVisible('[data-passkey-message="unsupported"]')).toBe(false)

    await page.click('form[data-passkey] button[type="submit"]')
    await page.waitForURL(`${origin}/account/passkeys`)

    expect(await page.textContent('.flash')).toContain('The passkey was created.')
    expect(await page.locator('table.list tbody tr').count()).toBe(1)
    const { credentials } = await devtools.send('WebAuthn.getCredentials', { authenticatorId })
    expect(credentials).toHaveLength(1)
    // What the device keeps: found without a name, for pforte's host, for this person.
    expect(credentials[0]).toMatchObject({ isResidentCredential: true, rpId: 'localhost' })
    const [row] = await stored()
    expect(Buffer.from(credentials[0]!.credentialId, 'base64').toString('base64url')).toBe(row.credential_id)
    expect(Buffer.from(credentials[0]!.userHandle!, 'base64').toString('hex')).toBe(row.user_id.replaceAll('-', ''))
    expect(complaints).toEqual([])
  })

  it('creates one in a browser that cannot read or write the JSON form itself', async () => {
    await page.addInitScript(() => {
      // @ts-expect-error: taking away what older browsers do not have
      delete PublicKeyCredential.parseCreationOptionsFromJSON
      // @ts-expect-error: as above
      delete PublicKeyCredential.prototype.toJSON
    })
    await page.goto(`${origin}/account/passkeys/new`)
    expect(await page.evaluate(() => typeof (PublicKeyCredential as unknown as Record<string, unknown>).parseCreationOptionsFromJSON)).toBe('undefined')

    await page.click('form[data-passkey] button[type="submit"]')
    await page.waitForURL(`${origin}/account/passkeys`)

    expect(await page.textContent('.flash')).toContain('The passkey was created.')
    expect(await stored()).toHaveLength(1)
    expect(complaints).toEqual([])
  })

  it('says so when the device already holds a passkey of this person, and makes no second', async () => {
    await page.goto(`${origin}/account/passkeys/new`)
    await page.click('form[data-passkey] button[type="submit"]')
    await page.waitForURL(`${origin}/account/passkeys`)

    await page.goto(`${origin}/account/passkeys/new`)
    await page.click('form[data-passkey] button[type="submit"]')

    await expect.poll(() => page.isVisible('[data-passkey-message="exists"]')).toBe(true)
    expect(await page.isVisible('[data-passkey-message="failed"]')).toBe(false)
    expect(await page.isEnabled('form[data-passkey] button[type="submit"]')).toBe(true)
    expect(page.url()).toBe(`${origin}/account/passkeys/new`)
    expect(await stored()).toHaveLength(1)
  })

  it('says so when the device does not go through with it, and can be tried again', async () => {
    await devtools.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false })
    await page.goto(`${origin}/account/passkeys/new`)

    await page.click('form[data-passkey] button[type="submit"]')

    await expect.poll(() => page.isVisible('[data-passkey-message="failed"]')).toBe(true)
    expect(await page.isEnabled('form[data-passkey] button[type="submit"]')).toBe(true)
    expect(await stored()).toEqual([])

    await devtools.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true })
    await page.click('form[data-passkey] button[type="submit"]')
    await page.waitForURL(`${origin}/account/passkeys`)
    expect(await stored()).toHaveLength(1)
  })

  it('removes a passkey with a plain form, on a page without any script', async () => {
    await page.goto(`${origin}/account/passkeys/new`)
    await page.click('form[data-passkey] button[type="submit"]')
    await page.waitForURL(`${origin}/account/passkeys`)
    expect(await page.locator('script').count()).toBe(0)

    await page.click('form[action="/account/passkeys/remove"] button')
    await page.waitForURL(`${origin}/account/passkeys`)

    expect(await page.textContent('.flash')).toContain('The passkey was removed')
    expect(await stored()).toEqual([])
  })

  it('leaves the page usable when the script does not run: the button is disabled and the page says why', async () => {
    const plain = await chrome.newContext({ javaScriptEnabled: false })
    try {
      const target = await plain.newPage()
      await signIn(target)
      await target.goto(`${origin}/account/passkeys/new`)

      expect(await target.isDisabled('form[data-passkey] button[type="submit"]')).toBe(true)
      expect(await target.isVisible('[data-passkey-message="unsupported"]')).toBe(true)
      expect(await target.isVisible('[data-passkey-message="failed"]')).toBe(false)
      // The way back is a link and works.
      await target.click('a.button.secondary')
      await target.waitForURL(`${origin}/account/passkeys`)
    } finally {
      await plain.close()
    }
  })

  describe('signing in', () => {
    const withPasskey = async () => {
      await page.goto(`${origin}/account/passkeys/new`)
      await page.click('form[data-passkey] button[type="submit"]')
      await page.waitForURL(`${origin}/account/passkeys`)
    }
    /** The same browser and device, as if on another day: signed out everywhere, the passkey still on the device. */
    const signedOut = () => context.clearCookies()
    /**
     * Takes the browser's autofill away, so that only the button asks the device. Chrome's device in software
     * answers the quiet question of the autofill by itself, as a person does who picks their passkey there.
     */
    const withoutAutofill = () =>
      page.addInitScript(() => {
        PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false)
      })

    it('signs in through the autofill of the e-mail field, without a click on the page', async () => {
      await withPasskey()
      await signedOut()

      await page.goto(`${origin}/account`)
      // Straight to the account pages, which insist on two factors: no password, no code.
      await page.waitForURL(`${origin}/account`)

      await page.goto(`${origin}/account/sessions`)
      expect(await page.textContent('table.list')).toContain('With a passkey')
      // The one code of this test was for the sign-in before the passkey existed.
      expect(h.notifications.filter((notification) => notification.kind === 'login-code')).toHaveLength(1)
      expect(complaints).toEqual([])
    })

    it('shows the passkey button once the script has run, and signs in with a click on it', async () => {
      await withPasskey()
      await signedOut()
      await withoutAutofill()

      await page.goto(`${origin}/account`)
      await page.waitForURL(/\/interaction\/[^/]+$/)
      await expect.poll(() => page.isVisible('form[data-passkey="get"] button')).toBe(true)
      await page.click('form[data-passkey="get"] button')

      await page.waitForURL(`${origin}/account`)
      expect(complaints).toEqual([])
    })

    it('signs in in a browser that cannot read or write the JSON form itself', async () => {
      await withPasskey()
      await signedOut()
      await page.addInitScript(() => {
        // @ts-expect-error: taking away what older browsers do not have
        delete PublicKeyCredential.parseRequestOptionsFromJSON
        // @ts-expect-error: as above
        delete PublicKeyCredential.prototype.toJSON
      })

      await page.goto(`${origin}/account`)

      await page.waitForURL(`${origin}/account`)
      expect(complaints).toEqual([])
    })

    it('says so when the device does not go through with it, and password and code still work on that page', async () => {
      await withPasskey()
      await signedOut()
      await devtools.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false })
      await page.goto(`${origin}/account`)
      await page.waitForURL(/\/interaction\/[^/]+$/)

      await page.click('form[data-passkey="get"] button')

      await expect.poll(() => page.isVisible('form[data-passkey="get"] [data-passkey-message="failed"]')).toBe(true)
      expect(await page.isEnabled('form[data-passkey="get"] button')).toBe(true)
      await page.fill('#email', EMAIL)
      await page.fill('#password', 'dev-password')
      await page.click('form[action$="/login"] button[type="submit"]')
      await page.waitForURL(/\/interaction\/[^/]+\/code$/)
    })

    it('says so when pforte does not know the passkey any more, on the login page', async () => {
      await withPasskey()
      await h.database.pool.query('delete from passkeys')
      await signedOut()
      await withoutAutofill()
      await page.goto(`${origin}/account`)
      await page.waitForURL(/\/interaction\/[^/]+$/)

      await page.click('form[data-passkey="get"] button')

      await page.waitForURL(/\/interaction\/[^/]+\/passkey$/)
      expect(await page.textContent('.error')).toContain('This passkey cannot sign in here.')
      // The page is a login page again, with its passkey button.
      await expect.poll(() => page.isVisible('form[data-passkey="get"] button')).toBe(true)
    })

    it('hides the passkey button where the script does not run: the page is the one for password and code', async () => {
      const plain = await chrome.newContext({ javaScriptEnabled: false })
      try {
        const target = await plain.newPage()
        await target.goto(`${origin}/account`)
        expect(await target.isVisible('form[data-passkey="get"]')).toBe(false)
        expect(await target.isVisible('#password')).toBe(true)
      } finally {
        await plain.close()
      }
    })
  })

  describe('the offer after a sign-in with a code', () => {
    it('comes on a device that can make a passkey, makes one, and is not made again', async () => {
      await context.clearCookies()

      await signIn(page, 'stop')
      expect(page.url()).toMatch(/\/passkey-offer$/)
      await expect.poll(() => page.isEnabled('form[data-passkey="create"] button[type="submit"]')).toBe(true)
      await page.click('form[data-passkey="create"] button[type="submit"]')
      await page.waitForURL(`${origin}/account`)

      expect(await stored()).toHaveLength(1)
      const { credentials } = await devtools.send('WebAuthn.getCredentials', { authenticatorId })
      expect(credentials).toHaveLength(1)
      expect(complaints).toEqual([])

      // The browser is not asked again: after the next code it goes straight on.
      await page.goto(`${origin}/account/passkeys`)
      await page.click('form[action="/account/passkeys/remove"] button')
      await page.waitForURL(`${origin}/account/passkeys`)
      // Gone from the device as well: otherwise it would answer the login page with a passkey pforte no longer knows.
      await devtools.send('WebAuthn.clearCredentials', { authenticatorId })
      const cookies = await context.cookies(`${origin}/interaction/x`)
      await context.clearCookies()
      await context.addCookies(cookies.filter((cookie) => cookie.name === 'pforte_passkey_offer'))
      await signIn(page, 'stop')
      expect(page.url()).toBe(`${origin}/account`)
    })

    it('does not come where the device cannot check its person', async () => {
      const other = await chrome.newContext()
      try {
        const target = await other.newPage()
        const session = await other.newCDPSession(target)
        await session.send('WebAuthn.enable')
        // A security key on a cable: no face, no finger, nothing of the device's own.
        await session.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: false, automaticPresenceSimulation: true } })

        await signIn(target, 'stop')

        expect(target.url()).toBe(`${origin}/account`)
      } finally {
        await other.close()
      }
    })

    it('goes on with "Not now"', async () => {
      await context.clearCookies()
      await signIn(page, 'not now')
      expect(page.url()).toBe(`${origin}/account`)
      expect(await stored()).toEqual([])
    })
  })

  it('lets the policy stop every script but its own', async () => {
    await page.goto(`${origin}/account/passkeys/new`)
    complaints.length = 0

    // What an injected script would be: one in the page, and one from pforte's own host under another address.
    const ran = await page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const marks: string[] = []
          ;(window as unknown as { mark: (name: string) => void }).mark = (name) => marks.push(name)
          const inline = document.createElement('script')
          inline.textContent = 'window.mark("inline")'
          document.body.append(inline)
          const other = document.createElement('script')
          other.src = '/health'
          other.onload = () => marks.push('other')
          other.onerror = () => resolve(marks)
          document.body.append(other)
        }),
    )

    expect(ran).toEqual([])
    expect(complaints.join('\n')).toMatch(/Content Security Policy/)
  })
})
