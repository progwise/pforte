import { type Browser, chromium, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createUi } from './index.js'
import { contrastRatio, darkColors, DEFAULT_COLORS, plainTheme, type Theme, withDark, withSignet } from './theme.js'

/**
 * Light and dark in a real browser: which of the two a page is depends on what the page says (`data-color-scheme`,
 * from the application) and on the device, and only a browser can say which rule of the stylesheet wins and
 * whether what it then draws can be read.
 */

const LOGO = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 40" width="160" height="40"><rect width="160" height="40" fill="#162438"/></svg>')}`
const BRAND_COLORS = { ...DEFAULT_COLORS, background: '#f6f3ec', surface: '#fffdf7', primary: '#162438', primaryText: '#ffffff', link: '#2a4a6b' }
const neutral = withSignet(withDark(plainTheme()))
const brand: Theme = { ...plainTheme(), name: 'Example Inc.', logoUrl: LOGO, colors: BRAND_COLORS, dark: { colors: darkColors(BRAND_COLORS), logoTile: true } }
const lightOnly: Theme = { ...brand, dark: undefined }

const CONTENT = `<h1>Users</h1>
<p class="flash ok" role="status">Saved.</p>
<p class="flash error" role="alert">That did not work.</p>
<div class="panel"><p>Text <a href="#">a link</a> <small>a hint</small> <span class="badge active">active</span> <span class="badge locked">locked</span> <span class="badge">invited</span></p>
<div class="actions"><a class="button" href="#">Edit</a><form><button class="secondary">Cancel</button></form><form><button class="danger">Delete</button></form></div>
<form class="fields"><div><label for="a">First name</label><input id="a" value="Anna"></div><div><label for="b">E-mail</label><input id="b" readonly value="anna.schmidt@example.com"></div></form></div>
<table class="list"><thead><tr><th>Name</th></tr></thead><tbody><tr><td><a href="#">Anna Schmidt</a><small>since yesterday</small></td></tr></tbody></table>`

const area = (theme: Theme) =>
  createUi({ theme }).pages.for('en').manage({
    title: 'Users',
    sectionsLabel: 'Sections',
    nav: [
      { href: '/', label: 'Start' },
      { href: '/users', label: 'Users', current: true },
    ],
    person: { signedInAs: 'Signed in as Anna Schmidt', signOutLabel: 'Sign out' },
    content: CONTENT,
  })
const card = (theme: Theme) => createUi({ theme }).pages.for('en').login({ uid: 'u1', error: 'The e-mail address or the password is wrong.' })
/** The page as an application asked for it, the way `color-scheme.ts` writes it. */
const asked = (html: string, scheme: 'light' | 'dark') => html.replace('<html lang="en">', `<html lang="en" data-color-scheme="${scheme}">`)

describe('light and dark in a real browser', () => {
  let chrome: Browser
  let page: Page

  beforeAll(async () => {
    chrome = await chromium.launch({ channel: 'chrome' })
    page = await chrome.newPage()
  })

  afterAll(async () => {
    await chrome?.close()
  })

  const show = async (content: string, device: 'light' | 'dark', width = 1280) => {
    await page.emulateMedia({ colorScheme: device })
    await page.setViewportSize({ width, height: 800 })
    await page.setContent(content)
    await page.evaluate(() => Promise.all([...document.images].map((image) => image.decode().catch(() => undefined))))
  }
  /** A colour as the browser computed it, as the hex colour of the theme. */
  const hex = (color: string) => `#${(/rgba?\((\d+), (\d+), (\d+)/.exec(color) ?? []).slice(1, 4).map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`
  const style = (selector: string, property: 'color' | 'backgroundColor' | 'colorScheme') => page.locator(selector).first().evaluate((element, name) => getComputedStyle(element)[name], property)
  const background = async () => hex(await style('body', 'backgroundColor'))

  describe.each([
    ['the neutral look', neutral],
    ['a brand', brand],
  ])('%s', (_name, theme) => {
    const dark = theme.dark!.colors

    it.each([
      ['the device is dark and no application said anything', 'dark', undefined, 'dark'],
      ['the device is light and no application said anything', 'light', undefined, 'light'],
      ['an application said dark on a light device', 'light', 'dark', 'dark'],
      ['an application said light on a dark device', 'dark', 'light', 'light'],
      ['an application said dark on a dark device', 'dark', 'dark', 'dark'],
    ] as const)('where %s, the pages are %s … %s', async (_case, device, said, look) => {
      for (const html of [card(theme), area(theme)]) {
        await show(said ? asked(html, said) : html, device)
        expect(await background()).toBe(look === 'dark' ? dark.background : theme.colors.background)
        expect(hex(await style('body', 'color'))).toBe(look === 'dark' ? dark.text : theme.colors.text)
        // What the browser draws itself (the autofill of a field, a scroll bar) follows.
        expect(await style('html', 'colorScheme')).toBe(look)
      }
    })

    it.each([390, 1280])('can be read on a dark page at %d px: every text reaches 4.5:1 on what lies behind it', async (width) => {
      /** The contrast of an element's text and the first background that is painted behind it. */
      const contrast = async (selector: string) => {
        const [color, behind] = await page.locator(selector).first().evaluate((element) => {
          let ground: Element | null = element
          while (ground && ['rgba(0, 0, 0, 0)', 'transparent'].includes(getComputedStyle(ground).backgroundColor)) ground = ground.parentElement
          return [getComputedStyle(element).color, getComputedStyle(ground ?? document.body).backgroundColor]
        })
        return contrastRatio(hex(color!), hex(behind!))
      }
      await show(asked(card(theme), 'dark'), 'light', width)
      for (const selector of ['h1', 'label', '.error', 'input', 'button[type="submit"]', 'p.aside a', 'button.secondary']) {
        expect(await contrast(selector), `the card: ${selector}`).toBeGreaterThanOrEqual(4.5)
      }
      await show(asked(area(theme), 'dark'), 'light', width)
      if (width < 1200) await page.click('details.menu summary')
      const bar = width < 1200 ? ['details.menu summary', 'details.menu nav a', 'details.menu nav a[aria-current]', 'details.menu nav p', 'details.menu nav button'] : ['nav.sections a', 'nav.sections a[aria-current]', '.bar .who span', '.bar .who button']
      for (const selector of [...bar, '.page > h1', '.flash.ok', '.flash.error', '.panel p', '.panel a', '.panel small', '.badge.active', '.badge.locked', '.badge:not(.active):not(.locked)', 'a.button', '.page button.secondary', '.page button.danger', 'label', 'input#a', 'input[readonly]', 'table.list th', 'table.list td a', 'table.list td small']) {
        expect(await contrast(selector), `the area: ${selector}`).toBeGreaterThanOrEqual(4.5)
      }
    })
  })

  describe('the logo of a brand', () => {
    const tile = async () => ({ ground: hex(await style('.logo', 'backgroundColor')), box: (await page.locator('.logo').first().boundingBox())! })

    it('sits on a tile in the light colour of the card on a dark page, in its own shape', async () => {
      for (const html of [card(brand), area(brand)]) {
        await show(asked(html, 'dark'), 'light')
        const { ground, box } = await tile()
        expect(ground).toBe(BRAND_COLORS.surface)
        // 0.3rem above and below, 0.5rem left and right, around a logo four times as wide as high.
        expect((box.width - 16) / (box.height - 9.6)).toBeCloseTo(4, 1)
      }
    })

    it('has no tile on a light page', async () => {
      await show(asked(card(brand), 'light'), 'dark')
      expect(await style('.logo', 'backgroundColor')).toBe('rgba(0, 0, 0, 0)')
      expect((await tile()).box).toMatchObject({ width: 160, height: 40 })
    })

    it('has no tile where the brand says that it reads on dark', async () => {
      await show(asked(card({ ...brand, dark: { ...brand.dark!, logoTile: false } }), 'dark'), 'dark')
      expect(await style('.logo', 'backgroundColor')).toBe('rgba(0, 0, 0, 0)')
    })
  })

  it('leaves a theme without a dark variant light, whatever the device and an application say', async () => {
    for (const html of [card(lightOnly), asked(card(lightOnly), 'dark'), asked(area(lightOnly), 'dark')]) {
      await show(html, 'dark')
      expect(await background()).toBe(BRAND_COLORS.background)
      expect(hex(await style('body', 'color'))).toBe(BRAND_COLORS.text)
      expect(await style('.logo', 'backgroundColor')).toBe('rgba(0, 0, 0, 0)')
    }
  })
})
