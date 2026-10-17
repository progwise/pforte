import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildContentSecurityPolicy, buildCss, contrastRatio, contrastWarnings, DEFAULT_COLORS, defaultTheme } from './theme.js'

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
  })

  it('has no form-action, which browsers also apply to the redirect that ends a sign-in', () => {
    expect(buildContentSecurityPolicy(css, { fonts: {} })).not.toContain('form-action')
  })
})
