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

  /** Signs the person in to their account pages, as they would: password, then the code from the mail. */
  const signIn = async (target: Page) => {
    await target.goto(`${origin}/account`)
    await target.fill('#email', EMAIL)
    await target.fill('#password', 'dev-password')
    await target.click('button[type="submit"]')
    await target.waitForURL(/\/interaction\/[^/]+\/code$/)
    await target.fill('#code', h.notifications.findLast((notification) => notification.kind === 'login-code' && notification.user.email === EMAIL)!.code!)
    await target.click('button[type="submit"]')
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
