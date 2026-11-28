import { createServer } from 'node:net'
import { hasDatabase } from '@progwise/pforte-db/testing'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PICTURE_SIZE } from '../pictures/prepare.js'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { cameraPicture } from '../test/pictures.js'

/**
 * The picture of a person, in a real browser. What the server does with an upload is tested without one
 * (`picture-pages.test.ts`); this is about what only a browser shows: that the form sends a file the server takes,
 * and that the pages are allowed to load the picture they show.
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

describe.skipIf(!hasDatabase)('the picture of a person in a real browser', () => {
  let h: AdminHarness
  let origin: string
  let chrome: Browser
  let context: BrowserContext
  let page: Page
  /** What the browser complained about: a picture its policy did not let it load. */
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

  beforeEach(async () => {
    await h.settle()
    h.notifications.length = 0
    await h.database.pool.query('delete from rate_limits')
    await h.database.pool.query('delete from otp_codes')
    await h.database.pool.query('delete from user_pictures')
    await h.database.pool.query(`update users set picture_key = null, language = 'en' where email = $1`, [EMAIL])
    complaints = []
    context = await chrome.newContext()
    page = await context.newPage()
    page.on('console', (message) => {
      if (message.type() === 'error') complaints.push(message.text())
    })
    page.on('pageerror', (error) => complaints.push(String(error)))

    // Signs the person in to their account pages, as they would: password, then the code from the mail.
    await page.goto(`${origin}/account`)
    await page.fill('#email', EMAIL)
    await page.fill('#password', 'dev-password')
    await page.click('form[action$="/login"] button[type="submit"]')
    await page.waitForURL(/\/interaction\/[^/]+\/code$/)
    await page.fill('#code', h.notifications.findLast((notification) => notification.kind === 'login-code' && notification.user.email === EMAIL)!.code!)
    await page.click('form[action$="/code"] button[type="submit"]')
    await page.waitForURL((url) => url.pathname === '/account' || url.pathname.endsWith('/passkey-offer'))
    if (page.url().endsWith('/passkey-offer')) await page.click('form[action$="/passkey-offer/skip"] button')
    await page.waitForURL(`${origin}/account`)
  })

  afterEach(async () => {
    await context?.close()
  })

  /** Whether the picture on the page was loaded, and how large it is. */
  const shown = () => page.$eval('img.avatar', (image) => ({ complete: (image as HTMLImageElement).complete, width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight }))

  it('uploads a photo with the form, and the overview and the page for the picture show it', async () => {
    await page.click('a[href="/account/picture"]')
    await page.setInputFiles('#picture', { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: await cameraPicture() })
    await page.click('form[enctype="multipart/form-data"] button[type="submit"]')
    await page.waitForURL(`${origin}/account`)

    expect(await page.textContent('.flash')).toContain('Your picture was saved.')
    await expect.poll(shown).toEqual({ complete: true, width: PICTURE_SIZE, height: PICTURE_SIZE })
    await page.click('a[href="/account/picture"]')
    await expect.poll(shown).toEqual({ complete: true, width: PICTURE_SIZE, height: PICTURE_SIZE })
    expect(complaints).toEqual([])
  })

  it('does not send a form without a file, and removes the picture with one click', async () => {
    await page.goto(`${origin}/account/picture`)
    await page.click('form[enctype="multipart/form-data"] button[type="submit"]')
    // The browser keeps the person on the page: the field is required.
    expect(page.url()).toBe(`${origin}/account/picture`)
    expect(await page.$eval('#picture', (field) => (field as HTMLInputElement).validity.valueMissing)).toBe(true)

    await page.setInputFiles('#picture', { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: await cameraPicture() })
    await page.click('form[enctype="multipart/form-data"] button[type="submit"]')
    await page.waitForURL(`${origin}/account`)
    await page.click('a[href="/account/picture"]')
    await page.click('form[action="/account/picture/remove"] button')
    await page.waitForURL(`${origin}/account`)

    expect(await page.textContent('.flash')).toContain('Your picture was removed.')
    expect(await page.$('img.avatar')).toBeNull()
    expect(complaints).toEqual([])
  })
})
