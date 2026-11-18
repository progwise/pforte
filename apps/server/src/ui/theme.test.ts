import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildContentSecurityPolicy, buildCss, contrastRatio, contrastWarnings, darkColors, DEFAULT_COLORS, defaultTheme, plainTheme, signetSvg, withDark } from './theme.js'

describe('contrast', () => {
  it('is 21 for black on white, 1 for the same colour, and reads short hex', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0)
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5)
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 0)
  })

  it('does not complain about the neutral look', () => {
    expect(contrastWarnings(defaultTheme())).toEqual([])
  })

  it('names every pair that is hard to read', () => {
    const warnings = contrastWarnings({ colors: { ...DEFAULT_COLORS, text: '#bbbbbb', primary: '#eeeeee', danger: '#ffcccc' } })
    expect(warnings.map((warning) => warning.replace(/: .*/, ''))).toEqual([
      'Low contrast for text',
      'Low contrast for text on the page background',
      'Low contrast for the main button (primary and primaryText)',
      'Low contrast for error messages (danger)',
    ])
  })
})

describe('the signet', () => {
  it('is drawn in the colours of the main button', () => {
    const svg = signetSvg({ primary: '#e6e448', primaryText: '#162438' })
    expect(svg).toContain('<rect width="32" height="32" rx="6" fill="#e6e448"/>')
    expect(svg).toContain('<path fill="#162438"')
  })

  it('is the icon and the logo of the neutral look, under an address that names its content', () => {
    const theme = defaultTheme()
    expect(theme.iconUrl).toMatch(/^\/brand\/[0-9a-f]{10}\/pforte\.svg$/)
    expect(theme.logoUrl).toBe(theme.iconUrl)
    expect(theme.assets).toEqual([{ path: theme.iconUrl!.replace('/brand/', ''), type: 'image/svg+xml', bytes: Buffer.from(signetSvg(DEFAULT_COLORS)) }])
  })

  it('is the icon of the documentation site as well: site/src/favicon.svg is the same drawing', () => {
    const favicon = readFileSync(new URL('../../../../site/src/favicon.svg', import.meta.url), 'utf8')
    expect(favicon, 'write the output of signetSvg(DEFAULT_COLORS) to site/src/favicon.svg').toBe(`${signetSvg(DEFAULT_COLORS)}\n`)
  })
})

describe('the dark colours', () => {
  const dark = darkColors(DEFAULT_COLORS)

  it('of the neutral look are readable: every pair that is checked reaches 4.5:1', () => {
    expect(defaultTheme().dark).toEqual({ colors: dark, logoTile: false })
    expect(contrastWarnings({ colors: dark })).toEqual([])
    expect(contrastWarnings(defaultTheme())).toEqual([])
    // What the check does not name: hints on the page itself, and the shape of the main button on the card.
    expect(contrastRatio(dark.muted, dark.background)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(dark.primary, dark.surface)).toBeGreaterThanOrEqual(3)
  })

  it('are dark: the page and the card are darker than the text on them', () => {
    expect(contrastRatio(dark.background, '#000000')).toBeLessThan(1.5)
    expect(contrastRatio(dark.surface, '#000000')).toBeLessThan(1.5)
    expect(contrastRatio(dark.text, '#ffffff')).toBeLessThan(1.5)
  })

  it('keep what carries the brand, in its own hue, and take the rest from pforte', () => {
    const brand = darkColors({ ...DEFAULT_COLORS, background: '#f6f3ec', surface: '#fffdf7', text: '#1d2b4a', primary: '#f2c94c', primaryText: '#1d2b4a', link: '#1d2b4a', danger: '#7a0000' })
    // A yellow button reads on a dark card as it is, with its own text.
    expect(brand).toMatchObject({ primary: '#f2c94c', primaryText: '#1d2b4a' })
    // A navy link does not: it becomes a lighter blue, not a grey.
    expect(brand.link).toMatch(/^#[0-9a-f]{6}$/)
    expect(brand.link).not.toBe('#1d2b4a')
    const [r, g, b] = [1, 3, 5].map((start) => Number.parseInt(brand.link.slice(start, start + 2), 16))
    expect(b!).toBeGreaterThan(g!)
    expect(g!).toBeGreaterThan(r!)
    expect({ ...brand, primary: '', primaryText: '', link: '' }).toEqual({ ...dark, primary: '', primaryText: '', link: '' })
  })

  it('give a button whose own text no longer reads black or white text, whichever does', () => {
    // A navy button becomes a lighter blue to stand out from the card, and keeps its white text.
    expect(darkColors({ ...DEFAULT_COLORS, primary: '#162438', primaryText: '#ffffff' })).toMatchObject({ primaryText: '#ffffff' })
    // A grey button with grey text that cannot be read on it.
    const grey = darkColors({ ...DEFAULT_COLORS, primary: '#999999', primaryText: '#aaaaaa' })
    expect(grey).toMatchObject({ primary: '#999999', primaryText: '#000000' })
  })

  describe('with colours the brand chose itself', () => {
    const light = { ...DEFAULT_COLORS, link: '#888888' }

    it('are calculated for the card and the page the brand chose, not for pforte\'s', () => {
      // On pforte's dark card this grey link reads as it is. On a lighter card of the brand it would not.
      expect(darkColors(light).link).toBe('#888888')
      expect(contrastRatio('#888888', '#333333')).toBeLessThan(4.5)
      const chosen = darkColors(light, { surface: '#333333' })
      expect(chosen.surface).toBe('#333333')
      expect(contrastRatio(chosen.link, '#333333')).toBeGreaterThanOrEqual(4.5)
      expect(contrastWarnings({ colors: chosen })).toEqual([])
      // The same for the page, and for the button that has to stand out from the card.
      expect(contrastRatio(darkColors(light, { background: '#3a3a3a' }).link, '#3a3a3a')).toBeGreaterThanOrEqual(4.5)
      const button = darkColors({ ...DEFAULT_COLORS, primary: '#777777', primaryText: '#000000' }, { surface: '#444444' })
      expect(contrastRatio(button.primary, '#444444')).toBeGreaterThanOrEqual(3)
      expect(contrastRatio(button.primary, button.primaryText)).toBeGreaterThanOrEqual(4.5)
    })

    it('take what the brand names as it is, also where it reads badly: that is a warning, not a correction', () => {
      const chosen = darkColors(light, { surface: '#333333', link: '#777777', primary: '#222222', primaryText: '#333333' })
      expect(chosen).toMatchObject({ surface: '#333333', link: '#777777', primary: '#222222', primaryText: '#333333' })
      expect(contrastWarnings({ colors: chosen })).toHaveLength(3)
    })

    it('give a button the brand chose a text that reads on it', () => {
      expect(darkColors({ ...DEFAULT_COLORS, primaryText: '#ffffff' }, { primary: '#f2c94c' })).toMatchObject({ primary: '#f2c94c', primaryText: '#000000' })
    })
  })

  it('are readable whatever the colours of the brand are', () => {
    const steps = ['00', '33', '66', '99', 'cc', 'ff']
    const all = steps.flatMap((r) => steps.flatMap((g) => steps.map((b) => `#${r}${g}${b}`)))
    for (const color of all) {
      for (const primaryText of ['#ffffff', '#000000', color]) {
        const colors = darkColors({ ...DEFAULT_COLORS, primary: color, primaryText, link: color })
        expect(contrastWarnings({ colors }), `${color} with ${primaryText}`).toEqual([])
        expect(contrastRatio(colors.primary, colors.surface), color).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('are named when they are hard to read, as dark ones', () => {
    const theme = { colors: DEFAULT_COLORS, dark: { colors: { ...dark, link: '#333333' }, logoTile: false } }
    expect(contrastWarnings(theme).map((warning) => warning.replace(/: .*/, ''))).toEqual(['Low contrast for links on the card on a dark page', 'Low contrast for links on the page background on a dark page'])
  })
})

describe('the stylesheet of a theme with a dark variant', () => {
  const theme = defaultTheme()
  const css = buildCss(theme)
  const variables = (colors: typeof DEFAULT_COLORS) =>
    `--background: ${colors.background}; --surface: ${colors.surface}; --text: ${colors.text}; --muted: ${colors.muted};\n  --border: ${colors.border}; --primary: ${colors.primary}; --primary-text: ${colors.primaryText}; --link: ${colors.link};\n  --danger: ${colors.danger}; --danger-background: ${colors.dangerBackground};`

  it('is one stylesheet: light first, then dark where the page says so, then dark where the device says so and the page does not say light', () => {
    const light = css.indexOf(`:root {\n  ${variables(DEFAULT_COLORS)}`)
    const asked = css.indexOf(`:root[data-color-scheme="dark"] {\n  ${variables(theme.dark!.colors)}`)
    const device = css.indexOf(`@media (prefers-color-scheme: dark) {\n:root:not([data-color-scheme="light"]) {\n  ${variables(theme.dark!.colors)}`)
    expect(light).toBeGreaterThan(-1)
    expect(asked).toBeGreaterThan(light)
    expect(device).toBeGreaterThan(asked)
  })

  it('tells the browser which it is, so that what the browser draws itself fits', () => {
    expect(css).toMatch(/:root \{[^}]*color-scheme: light;/)
    expect(css.match(/color-scheme: dark;/g)).toHaveLength(2)
  })

  it('writes no colour of a text or a line into a rule: they are variables, with a value for dark', () => {
    const rules = css.slice(css.indexOf('*, *::before'))
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,6}\b/)
    expect(rules).toContain('.flash.ok { border-color: var(--ok); }')
    expect(rules).toContain('.badge.active { border-color: var(--ok); color: var(--ok); }')
    expect(rules).toContain('.page button.danger { background: var(--danger); color: var(--on-danger); }')
    expect(css).toMatch(/:root \{[^}]*--ok: #2e7d32; --on-danger: #fff;/)
    // The green of a confirmation reads on the dark card and on the dark page, and the text on a red button on the red.
    expect(css.match(/--ok: #7bd88f; --on-danger: var\(--danger-background\);/g)).toHaveLength(2)
    expect(contrastRatio('#7bd88f', theme.dark!.colors.surface)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio('#7bd88f', theme.dark!.colors.background)).toBeGreaterThanOrEqual(4.5)
  })

  it('puts the logo on a tile in the light colour of the card on a dark page, where the theme asks for it', () => {
    expect(css).not.toContain('.logo { padding')
    const tiled = buildCss({ ...theme, colors: { ...DEFAULT_COLORS, surface: '#fffdf7' }, dark: { ...theme.dark!, logoTile: true } })
    expect(tiled).toContain(':root[data-color-scheme="dark"] .logo { padding: 0.3rem 0.5rem; background: #fffdf7; border-radius: var(--radius-small); }')
    expect(tiled).toContain(':root:not([data-color-scheme="light"]) .logo { padding: 0.3rem 0.5rem; background: #fffdf7; border-radius: var(--radius-small); }')
  })

  it('has nothing of this without a dark variant: the theme is light for everybody, as before', () => {
    const light = buildCss(plainTheme())
    expect(light).not.toContain('prefers-color-scheme')
    expect(light).not.toContain('data-color-scheme')
    expect(light).not.toContain('color-scheme:')
    expect(buildCss(withDark(plainTheme()))).toBe(css)
  })
})

describe('the stylesheet', () => {
  it('uses the colours and radius of the theme, and fonts the system has when none is given', () => {
    const css = buildCss({ ...defaultTheme(), radius: '18px', colors: { ...DEFAULT_COLORS, primary: '#e6e448' } })
    expect(css).toContain('--primary: #e6e448')
    expect(css).toContain('--radius: 18px')
    expect(css).toContain('--font-body: system-ui')
    expect(css).not.toContain('@font-face')
  })

  it('declares the fonts it is given, and falls back to the system ones', () => {
    const css = buildCss({
      ...defaultTheme(),
      fonts: {
        body: { family: 'Example Sans', files: [{ url: '/brand/ab12/Regular.woff2', weight: 400, style: 'normal', format: 'woff2' }] },
        heading: { family: 'Example Display', files: [{ url: '/brand/cd34/Bold.woff', weight: 700, style: 'italic', format: 'woff' }] },
      },
    })
    expect(css).toContain('@font-face { font-family: "Example Sans"; src: url("/brand/ab12/Regular.woff2") format("woff2"); font-weight: 400; font-style: normal; font-display: swap; }')
    expect(css).toContain('format("woff"); font-weight: 700; font-style: italic')
    expect(css).toContain('--font-body: "Example Sans", system-ui')
    expect(css).toContain('--font-heading: "Example Display", system-ui')
  })

  it('uses the body font for headings when there is no heading font', () => {
    const css = buildCss({
      ...defaultTheme(),
      fonts: { body: { family: 'Only One', files: [{ url: '/brand/x/a.woff2', weight: 400, style: 'normal', format: 'woff2' }] } },
    })
    expect(css).toContain('--font-heading: var(--font-body)')
  })
})

describe('the content security policy', () => {
  const css = 'a { color: red }'
  const hash = createHash('sha256').update(css).digest('base64')

  it('allows nothing but the exact stylesheet when there are no fonts and no logo', () => {
    const policy = buildContentSecurityPolicy(css, { fonts: {} })
    expect(policy).toContain(`style-src 'sha256-${hash}'`)
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).not.toContain('font-src')
    expect(policy).not.toContain('img-src')
    expect(policy).not.toContain('script-src')
  })

  it('opens fonts and images for our own address only, when there are some', () => {
    const font = { family: 'A', files: [] }
    expect(buildContentSecurityPolicy(css, { fonts: { body: font } })).toContain("font-src 'self'")
    expect(buildContentSecurityPolicy(css, { fonts: {}, logoUrl: '/brand/x/logo.svg' })).toContain("img-src 'self'")
    expect(buildContentSecurityPolicy(css, { fonts: {}, iconUrl: '/brand/x/pforte.svg' })).toContain("img-src 'self'")
  })

  it('has no form-action, which browsers also apply to the redirect that ends a sign-in', () => {
    expect(buildContentSecurityPolicy(css, { fonts: {} })).not.toContain('form-action')
  })
})
