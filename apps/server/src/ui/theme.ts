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

/* The administration: a wide layout with a bar and sections, tables and forms. */
body.manage { display: block; padding: 0; min-height: 100vh; }
.bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.25rem 1.5rem; padding: 0 1rem;
  background: var(--surface); border-bottom: 1px solid var(--border); box-shadow: 0 1px 3px rgb(0 0 0 / 8%); }
.bar .who { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; font-size: 0.9rem; color: var(--muted); }
.bar form { margin: 0; }
.bar button { width: auto; padding: 0.5rem 0.9rem; margin: 0; }
.bar .logo, .bar .brand { margin: 0; max-height: 2.5rem; font-size: 1rem; }
nav.sections { display: flex; flex-wrap: wrap; gap: 0.25rem; }
nav.sections a { display: inline-flex; align-items: center; min-height: 3.25rem; padding: 0 0.9rem; border-bottom: 3px solid transparent;
  color: var(--text); font: 600 0.95rem var(--font-heading); text-decoration: none; }
nav.sections a:hover { background: var(--background); }
nav.sections a[aria-current="page"] { border-bottom-color: var(--link); color: var(--link); }
.page { max-width: 66rem; margin: 1.5rem auto 3rem; padding: 0 1rem; background: transparent; box-shadow: none; border-radius: 0; }
.page > h1 { margin-bottom: 1.25rem; font-size: 1.7rem; }
.page h2 { margin: 2rem 0 0.75rem; font: 600 1.15rem var(--font-heading); }
.flash { margin-bottom: 1rem; padding: 0.75rem 1rem; border-radius: var(--radius-small); border: 1px solid var(--border); background: var(--surface); }
.flash.ok { border-color: #2e7d32; }
.flash.error { border-color: var(--danger); color: var(--danger); background: var(--danger-background); }
.panel { padding: 1rem 1.25rem; margin-bottom: 1rem; background: var(--surface); border-radius: var(--radius); box-shadow: 0 1px 3px rgb(0 0 0 / 12%); }
table.list { width: 100%; border-collapse: collapse; background: var(--surface); border-radius: var(--radius-small); overflow: hidden; box-shadow: 0 1px 3px rgb(0 0 0 / 12%); }
table.list th, table.list td { padding: 0.7rem 0.85rem; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border); }
table.list th { font: 600 0.85rem var(--font-heading); color: var(--muted); }
table.list tr:last-child td { border-bottom: 0; }
.scroll { overflow-x: auto; }
.badge { display: inline-block; padding: 0.1rem 0.55rem; border-radius: 999px; border: 1px solid var(--border); font-size: 0.8rem; background: var(--background); }
.badge.active { border-color: #2e7d32; color: #2e7d32; }
.badge.locked, .badge.deactivated { border-color: var(--danger); color: var(--danger); }
.actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 1rem 0; }
.actions form { margin: 0; }
a.button, .page button { display: inline-flex; align-items: center; justify-content: center; width: auto; min-height: 2.75rem; padding: 0 1.1rem; margin: 0;
  border: 0; border-radius: var(--radius-small); background: var(--primary); color: var(--primary-text); font: 600 1rem var(--font-heading); text-decoration: none; cursor: pointer; }
a.button.secondary, .page button.secondary { background: transparent; color: var(--link); box-shadow: inset 0 0 0 1px var(--input-border); margin-top: 0; }
.page button.danger { background: var(--danger); color: #fff; }
.page form.fields { display: grid; gap: 0.25rem 1rem; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); align-items: start; }
.page form.fields.stack { grid-template-columns: minmax(0, 40rem); }
.page form.fields .submit { align-self: end; margin-bottom: 0.75rem; display: flex; flex-wrap: wrap; gap: 0.5rem; }
.page input:not([type="checkbox"]), .page select { min-height: 3rem; }
.page small.muted { display: block; margin: -0.25rem 0 1rem; }
.page form.fields > label, .page form.fields > div { margin: 0; }
.page form.fields input, .page form.fields select { margin-bottom: 0.75rem; }
.page textarea { width: 100%; padding: 0.7rem; margin-bottom: 0.25rem; font: inherit; color: inherit; background: var(--surface); border: 1px solid var(--input-border); border-radius: var(--radius-small); }
.page select { width: 100%; padding: 0.7rem; font: inherit; color: inherit; background: var(--surface); border: 1px solid var(--input-border); border-radius: var(--radius-small); }
.muted { color: var(--muted); }
.field-error { display: block; color: var(--danger); }
.page label.check { align-items: center; min-height: 2.75rem; margin: 0; }
.page label.check input, .page input[type="checkbox"] { width: 1.25rem; height: 1.25rem; margin: 0; }
fieldset.group { margin: 0 0 1rem; padding: 0; border: 0; }
fieldset.group legend { padding: 0; margin-bottom: 0.25rem; font-weight: 600; }
fieldset.group label.check { min-height: 2.25rem; }
code.secret { display: block; padding: 0.8rem; margin: 1rem 0; overflow-wrap: anywhere; font: 1rem ui-monospace, monospace; background: var(--background); border: 1px solid var(--border); border-radius: var(--radius-small); user-select: all; }
.cards { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
.cards .panel { margin: 0; }
.cards h2, .panel > h2:first-child { margin-top: 0; }
.events { background: var(--surface); border-radius: var(--radius-small); box-shadow: 0 1px 3px rgb(0 0 0 / 12%); overflow: hidden; }
.events .cols { display: grid; grid-template-columns: 13rem 1.2fr 1.2fr 1.2fr 8rem; gap: 0.25rem 1rem; align-items: start; padding: 0.7rem 0.85rem; }
.events .head { font: 600 0.85rem var(--font-heading); color: var(--muted); }
.events .event { border-top: 1px solid var(--border); }
.events summary { cursor: pointer; list-style: none; }
.events summary::-webkit-details-marker { display: none; }
.events summary > span:first-child::before { content: "▸"; display: inline-block; width: 1rem; color: var(--link); }
.events details[open] > summary > span:first-child::before { content: "▾"; }
.events .event:not(details) .cols > span:first-child { padding-left: 1rem; }
.events summary:hover { background: var(--background); }
.events .body { padding: 0 0.85rem 0.85rem 2.35rem; }
.events .body pre { margin: 0; padding: 0.7rem; overflow-x: auto; font: 0.85rem/1.4 ui-monospace, monospace; background: var(--background); border-radius: var(--radius-small); }
.events .body p { margin: 0.5rem 0 0; }
.events small { display: block; }
@media (max-width: 50rem) { .events .head { display: none; } .events .cols { grid-template-columns: 1fr; } }
.nowrap { white-space: nowrap; }
table.list small { display: block; }
dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: 0.4rem 1.25rem; margin: 0; }
dl.facts dt { color: var(--muted); }
dl.facts dd { margin: 0; }
@media (max-width: 40rem) { dl.facts { grid-template-columns: 1fr; } dl.facts dt { margin-top: 0.5rem; } }
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
