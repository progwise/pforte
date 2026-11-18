import { type Browser, chromium, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MessageKey } from '../i18n/index.js'
import { createUi } from './index.js'
import { plainTheme, type Theme, withSignet } from './theme.js'

/**
 * The bar of the account pages and of the administration, laid out by a real browser: whether it is one line, and
 * what is in it, is decided by the stylesheet and the width of the screen, and only a browser can say how that ends.
 * The pages are made as the server makes them and given to the browser as they are; nothing is signed in.
 */

/** A wordmark, ten times as wide as high: the logo that is hardest on a bar. */
const WORDMARK = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 40" width="400" height="40"><rect width="400" height="40" fill="#0b5cad"/></svg>')}`
const THEMES: Record<string, Theme> = {
  'a wordmark as logo': { ...plainTheme(), name: 'Example Inc.', logoUrl: WORDMARK },
  'a name and no logo': withSignet({ ...plainTheme(), name: 'Example Inc.' }),
  // Without a branding folder the logo is pforte's signet: a square, stood in for by one the browser can load here.
  'no branding at all': { ...withSignet(plainTheme()), logoUrl: WORDMARK.replaceAll('400', '40') },
}

const ACCOUNT: MessageKey[] = ['account.nav.start', 'account.nav.sessions', 'account.nav.devices', 'account.nav.signIns', 'account.nav.passkeys', 'account.nav.password']
const MANAGE: MessageKey[] = ['manage.nav.home', 'manage.nav.users', 'manage.nav.clients', 'manage.nav.claimTypes', 'manage.nav.audit', 'manage.nav.import']
/** Both areas, in every language they have. */
const AREAS = [
  ...['en', 'de', 'fr', 'hu'].map((language) => ({ area: 'the account pages', language, sections: ACCOUNT, label: 'account.nav.label' as const, signedInAs: 'account.signedInAs' as const, signOut: 'account.signOut' as const })),
  ...['en', 'de'].map((language) => ({ area: 'the administration', language, sections: MANAGE, label: 'manage.nav.label' as const, signedInAs: 'manage.signedInAs' as const, signOut: 'manage.signOut' as const })),
]
type Area = (typeof AREAS)[number]

const TABLE = '<table class="list stack"><thead><tr><th>Device</th><th>Last used</th></tr></thead><tbody><tr><td data-label="Device">Chrome on macOS</td><td data-label="Last used">today</td></tr></tbody></table>'

/** A page of the area, with its section number `current` open. */
const html = (theme: Theme, { language, sections, label, signedInAs, signOut }: Area, { current = 0, name = 'Anna Schmidt' } = {}) => {
  const { i18n, pages } = createUi({ theme })
  const t = (key: MessageKey, values?: Record<string, string>) => i18n.text(language, key, values)
  return pages.for(language).manage({
    title: t(sections[current]!),
    sectionsLabel: t(label),
    nav: sections.map((key, index) => ({ href: `/section-${index}`, label: t(key), current: index === current })),
    person: { signedInAs: t(signedInAs, { name }), signOutLabel: t(signOut), signOutAction: '/account/logout' },
    content: TABLE,
  })
}

/** Phones upright (360, 390), phones held sideways (667, 844, 932), a tablet upright (1024), and the last width before the wide bar. */
const ONE_LINE = [360, 390, 667, 844, 932, 1024, 1200]
const WIDE = 1280
const REM = 16
/** The one-line bar: the menu of 2.75rem with 0.5rem above and below, and the line below the bar. */
const ONE_LINE_HEIGHT = 3.75 * REM + 1
/** The wide bar in one row: the sections of 3.5rem and the line below the bar. */
const WIDE_HEIGHT = 3.5 * REM + 1

describe('the bar in a real browser', () => {
  let chrome: Browser
  let page: Page

  beforeAll(async () => {
    chrome = await chromium.launch({ channel: 'chrome' })
    page = await chrome.newPage()
  })

  afterAll(async () => {
    await chrome?.close()
  })

  const show = async (content: string, width: number, height = 800) => {
    await page.setViewportSize({ width, height })
    await page.setContent(content)
    // The height of the bar depends on the logo: wait until it is there.
    await page.evaluate(() => Promise.all([...document.images].map((image) => image.decode().catch(() => undefined))))
  }
  const box = async (selector: string) => (await page.locator(selector).boundingBox())!
  const visible = (selector: string) => page.locator(selector).isVisible()
  const MARK = '.bar > :first-child'

  describe.each(Object.entries(THEMES))('with %s', (_name, theme) => {
    describe.each(AREAS)('of $area in $language', (area) => {
      it.each(ONE_LINE)('is one line at %d px: the logo and the menu', async (width) => {
        // A phone held sideways is low.
        await show(html(theme, area), width, width > 600 && width < 1000 ? 400 : 800)
        expect((await box('.bar')).height).toBe(ONE_LINE_HEIGHT)
        expect(await visible('nav.sections')).toBe(false)
        expect(await visible('.bar .who')).toBe(false)
        expect(await visible('details.menu summary')).toBe(true)
        expect(await visible('details.menu nav')).toBe(false)
        // Nothing touches the top edge, and nothing reaches beyond the screen.
        expect((await box(MARK)).y).toBeGreaterThanOrEqual(0.5 * REM)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
      })

      it('names every page in full in the closed menu of the narrowest phone', async () => {
        for (const current of area.sections.keys()) {
          await show(html(theme, area, { current }), 360)
          const name = page.locator('details.menu summary span')
          expect(await name.evaluate((span) => span.scrollWidth <= span.clientWidth), (await name.textContent()) ?? '').toBe(true)
        }
      })

      it('is the wide bar at 1,280 px: the sections side by side and the button to sign out, with room around the logo', async () => {
        await show(html(theme, area), WIDE)
        expect(await visible('details.menu')).toBe(false)
        expect(await visible('nav.sections')).toBe(true)
        expect(await visible('.bar .who button')).toBe(true)
        const mark = await box(MARK)
        const sections = await box('nav.sections')
        expect(mark.y).toBeGreaterThanOrEqual(0.5 * REM)
        expect(sections.y + sections.height - (mark.y + mark.height)).toBeGreaterThanOrEqual(0.5 * REM)
      })
    })
  })

  describe('the opened menu', () => {
    const [account] = AREAS

    it.each([
      [390, 800],
      [844, 390],
    ])('at %d by %d px holds the sections, who is signed in, and the button to sign out as its last entry', async (width, height) => {
      await show(html(THEMES['a wordmark as logo']!, account!, { current: 3 }), width, height)
      await page.click('details.menu summary')

      const links = page.locator('details.menu nav a')
      expect(await links.count()).toBe(6)
      expect(await links.nth(3).getAttribute('aria-current')).toBe('page')
      expect(await page.locator('details.menu nav p').textContent()).toBe('Signed in as Anna Schmidt')

      // A form with a button, so it signs out without a script. It is the last thing in the menu, as wide as the menu.
      expect(await page.locator('details.menu nav > :last-child').evaluate((last) => last.outerHTML)).toBe(
        '<form method="post" action="/account/logout"><button type="submit" class="secondary">Sign out</button></form>',
      )
      expect(await page.locator('script').count()).toBe(0)
      const button = await box('details.menu nav button')
      const who = await box('details.menu nav p')
      expect(button.y).toBeGreaterThanOrEqual(who.y + who.height)
      expect(button.height).toBeGreaterThanOrEqual(2.75 * REM)
      expect(button.x).toBe(REM)
      expect(button.width).toBe(width - 2 * REM)

      // The menu lies over the page and does not move it: the bar stays one line.
      expect((await box('.bar')).height).toBe(ONE_LINE_HEIGHT)
      // On a low screen the menu is longer than the screen: the page scrolls as far as the button.
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThanOrEqual(button.y + button.height)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
    })

    it('sends the form of the button where the area signs out', async () => {
      await page.route('http://pforte.test/**', (route) =>
        route.request().method() === 'POST'
          ? route.fulfill({ contentType: 'text/html', body: `<p id="sent">${new URL(route.request().url()).pathname}</p>` })
          : route.fulfill({ contentType: 'text/html', body: html(THEMES['a name and no logo']!, account!) }),
      )
      await page.setViewportSize({ width: 390, height: 800 })
      await page.goto('http://pforte.test/account')
      await page.click('details.menu summary')
      await page.click('details.menu nav button')
      await page.waitForSelector('#sent')
      expect(await page.textContent('#sent')).toBe('/account/logout')
      await page.unroute('http://pforte.test/**')
    })
  })

  describe('the wide bar', () => {
    const [account] = AREAS

    it('is one row as high as its sections where everything fits', async () => {
      await show(html(THEMES['no branding at all']!, account!), WIDE)
      expect((await box('.bar')).height).toBe(WIDE_HEIGHT)
    })

    it('touches no edge where it does wrap: a long name takes the button to sign out to a row of its own', async () => {
      await show(html(THEMES['a wordmark as logo']!, account!, { name: 'Maximiliane Alexandra von Hohenberg-Lichtenstein zu Example' }), WIDE)
      const bar = await box('.bar')
      const sections = await box('nav.sections')
      const button = await box('.bar .who button')
      expect(bar.height).toBeGreaterThan(WIDE_HEIGHT)
      expect((await box(MARK)).y).toBeGreaterThanOrEqual(0.5 * REM)
      expect(button.y).toBeGreaterThanOrEqual(sections.y + sections.height + 0.5 * REM)
      expect(bar.y + bar.height - 1 - (button.y + button.height)).toBeGreaterThanOrEqual(0.5 * REM)
    })
  })

  describe('the page below the bar', () => {
    const [account] = AREAS
    const display = (selector: string) => page.locator(selector).evaluate((element) => getComputedStyle(element).display)

    it('keeps its lists as tables where the bar is one line but the screen is no phone', async () => {
      await show(html(THEMES['no branding at all']!, account!), 844, 390)
      expect(await display('table.stack')).toBe('table')
      expect(await display('table.stack thead')).toBe('table-header-group')
    })

    it('stacks the cells of a list on a phone', async () => {
      await show(html(THEMES['no branding at all']!, account!), 390)
      expect(await display('table.stack')).toBe('block')
      expect(await display('table.stack thead')).toBe('none')
    })
  })
})
