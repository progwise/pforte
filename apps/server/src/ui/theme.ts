import { createHash } from 'node:crypto'

/** The colours of a theme. Every page is drawn with these and nothing else. */
export interface Colors {
  background: string
  surface: string
  text: string
  /** Hints and footer links. */
  muted: string
  border: string
  /** The main button. */
  primary: string
  primaryText: string
  link: string
  danger: string
  dangerBackground: string
}

export interface FontFile {
  /** Where pforte serves the file. */
  url: string
  weight: number
  style: 'normal' | 'italic'
  format: 'woff2' | 'woff'
}

export interface Font {
  family: string
  files: FontFile[]
}

export interface FooterLink {
  /** One text for all languages, or a text per language (`en` is the fallback). */
  label: string | Record<string, string>
  url: string
}

/** A file pforte serves for the pages: the logo or a font. */
export interface Asset {
  /** Path below `/brand/`. */
  path: string
  type: string
  bytes: Uint8Array
}

export interface Theme {
  colors: Colors
  radius: string
  fonts: { body?: Font; heading?: Font }
  /** The logo, as a URL under `/brand/`. */
  logoUrl?: string
  links: FooterLink[]
  assets: Asset[]
  /** The name shown with (or instead of) the logo. */
  name?: string
}

/** The neutral look pforte has without a branding folder. */
export const DEFAULT_COLORS: Colors = {
  background: '#f4f5f7',
  surface: '#ffffff',
  text: '#1b1f24',
  muted: '#57606a',
  border: '#d0d7de',
  primary: '#0b5cad',
  primaryText: '#ffffff',
  link: '#0b5cad',
  danger: '#82071e',
  dangerBackground: '#ffebe9',
}

export const DEFAULT_RADIUS = '8px'

export const defaultTheme = (): Theme => ({ colors: { ...DEFAULT_COLORS }, radius: DEFAULT_RADIUS, fonts: {}, links: [], assets: [] })

// --- contrast, so a theme that cannot be read is noticed at startup

const channel = (value: number) => {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

const luminance = (hex: string) => {
  const full = hex.length === 4 ? `#${Array.from(hex.slice(1), (digit) => digit + digit).join('')}` : hex
  const [r, g, b] = [1, 3, 5].map((start) => channel(Number.parseInt(full.slice(start, start + 2), 16)))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

/** WCAG contrast ratio of two colours, from 1 (same) to 21 (black on white). */
export const contrastRatio = (a: string, b: string) => {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (lighter! + 0.05) / (darker! + 0.05)
}

/** Pairs that have to be readable, with the ratio WCAG asks of normal text. */
export const contrastWarnings = ({ colors }: Pick<Theme, 'colors'>) => {
  const pairs: [string, string, string][] = [
    ['text', colors.text, colors.surface],
    ['text on the page background', colors.text, colors.background],
    ['the main button (primary and primaryText)', colors.primary, colors.primaryText],
    ['links on the card', colors.link, colors.surface],
    ['links on the page background', colors.link, colors.background],
    ['hints (muted)', colors.muted, colors.surface],
    ['error messages (danger)', colors.danger, colors.dangerBackground],
  ]
  return pairs
    .map(([what, a, b]) => ({ what, ratio: contrastRatio(a, b) }))
    .filter(({ ratio }) => ratio < 4.5)
    .map(({ what, ratio }) => `Low contrast for ${what}: ${ratio.toFixed(1)}:1 (4.5:1 is the minimum for readable text).`)
}

// --- the stylesheet

const stack = (font?: Font) => (font ? `"${font.family}", ` : '') + 'system-ui, -apple-system, "Segoe UI", sans-serif'

/** The stylesheet of the pages. Every value in it was checked when the theme was loaded. */
export const buildCss = (theme: Theme) => {
  const { colors, radius, fonts } = theme
  const faces = Object.values(fonts)
    .flatMap((font) => font.files.map((file) => ({ family: font.family, file })))
    .map(
      ({ family, file }) =>
        `@font-face { font-family: "${family}"; src: url("${file.url}") format("${file.format}"); font-weight: ${file.weight}; font-style: ${file.style}; font-display: swap; }`,
    )
    .join('\n')

  return `${faces}
:root {
  --background: ${colors.background}; --surface: ${colors.surface}; --text: ${colors.text}; --muted: ${colors.muted};
  --border: ${colors.border}; --primary: ${colors.primary}; --primary-text: ${colors.primaryText}; --link: ${colors.link};
  --danger: ${colors.danger}; --danger-background: ${colors.dangerBackground};
  --radius: ${radius}; --radius-small: calc(${radius} * 0.66);
  --input-border: color-mix(in srgb, var(--text) 45%, var(--surface));
  --font-body: ${stack(fonts.body)}; --font-heading: ${fonts.heading ? stack(fonts.heading) : 'var(--font-body)'};
}
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1rem;
  padding: 1rem; font: 16px/1.5 var(--font-body); background: var(--background); color: var(--text); }
main { width: 100%; max-width: 24rem; background: var(--surface); padding: 2rem; border-radius: var(--radius);
  box-shadow: 0 1px 4px rgb(0 0 0 / 15%); }
.logo { display: block; max-width: 12rem; max-height: 4rem; margin: 0 auto 1.5rem; }
.brand { margin: 0 0 1.5rem; text-align: center; font: 600 1.1rem var(--font-heading); }
h1 { margin: 0 0 1.5rem; font: 600 1.4rem/1.3 var(--font-heading); }
label { display: block; margin-bottom: 0.25rem; font-weight: 600; font-family: var(--font-heading); }
input { width: 100%; padding: 0.7rem; margin-bottom: 1rem; font: inherit; color: inherit; background: var(--surface);
  border: 1px solid var(--input-border); border-radius: var(--radius-small); }
input:focus-visible, button:focus-visible, a:focus-visible { outline: 3px solid color-mix(in srgb, var(--link) 60%, transparent); outline-offset: 2px; }
input#code { text-align: center; font-size: 1.6rem; letter-spacing: 0.5em; padding-left: 0.5em; font-variant-numeric: tabular-nums; }
button { width: 100%; padding: 0.75rem; font: 600 1rem var(--font-heading); color: var(--primary-text); background: var(--primary);
  border: 0; border-radius: var(--radius-small); cursor: pointer; }
button.secondary { margin-top: 0.5rem; color: var(--link); background: transparent; }
label.check { display: flex; gap: 0.5rem; align-items: flex-start; margin-bottom: 1rem; font-weight: 400; font-family: var(--font-body); }
label.check input { width: auto; margin: 0.3rem 0 0; }
a { color: var(--link); }
small { color: var(--muted); }
input + p { margin: -0.5rem 0 1rem; }
.error { margin-bottom: 1rem; padding: 0.6rem; color: var(--danger); background: var(--danger-background); border-radius: var(--radius-small); }
nav.links { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.25rem 1.25rem; font-size: 0.875rem; }
nav.links a { color: var(--muted); }
`
}

/**
 * Content-Security-Policy of the pages: no scripts, our own fonts and logo, and only this exact stylesheet.
 * There is no `form-action`: browsers apply it to the redirects after a form too, and the sign-in ends with
 * one to the application.
 */
export const buildContentSecurityPolicy = (css: string, theme: Pick<Theme, 'fonts' | 'logoUrl'>) =>
  [
    "default-src 'none'",
    `style-src 'sha256-${createHash('sha256').update(css).digest('base64')}'`,
    ...(Object.keys(theme.fonts).length > 0 ? ["font-src 'self'"] : []),
    ...(theme.logoUrl ? ["img-src 'self'"] : []),
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ')
