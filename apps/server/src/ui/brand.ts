import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import {
  type Asset,
  contrastWarnings,
  DEFAULT_COLORS,
  defaultTheme,
  type Font,
  type FontFile,
  type FooterLink,
  type Theme,
} from './theme.js'

const MAX_LOGO_BYTES = 512 * 1024
const MAX_FONT_BYTES = 600 * 1024
const MAX_LINKS = 6

const LOGO_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}
const FONT_FORMATS: Record<string, { type: string; format: FontFile['format'] }> = {
  '.woff2': { type: 'font/woff2', format: 'woff2' },
  '.woff': { type: 'font/woff', format: 'woff' },
}

const TOP_LEVEL = ['name', 'logo', 'colors', 'radius', 'fonts', 'links'] as const
const COLOR_KEYS = Object.keys(DEFAULT_COLORS)
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const RADIUS = /^(\d{1,2})(px|rem)$/
const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/

export interface Brand {
  theme: Theme
  /** The organisation's name, if brand.json names it. */
  name?: string
  /** Things worth telling the administrator at startup. */
  warnings: string[]
}

class BrandError extends Error {
  constructor(message: string) {
    super(`brand.json: ${message}`)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Only keys we know, so a typo is an error and not a setting that silently does nothing. */
const onlyKnown = (value: Record<string, unknown>, allowed: readonly string[], where: string) => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) throw new BrandError(`${where} has unknown ${unknown.length > 1 ? 'entries' : 'entry'} ${unknown.map((key) => `"${key}"`).join(', ')}. Allowed: ${allowed.join(', ')}`)
}

const startsWith = (bytes: Uint8Array, ...signature: number[]) => signature.every((byte, index) => bytes[index] === byte)
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0))

/** Whether the content fits the extension, so a text file named logo.png or a renamed script is noticed. */
const looksLike = (extension: string, bytes: Uint8Array) => {
  switch (extension) {
    case '.woff2':
      return startsWith(bytes, ...ascii('wOF2'))
    case '.woff':
      return startsWith(bytes, ...ascii('wOFF'))
    case '.png':
      return startsWith(bytes, 0x89, 0x50, 0x4e, 0x47)
    case '.jpg':
    case '.jpeg':
      return startsWith(bytes, 0xff, 0xd8, 0xff)
    case '.webp':
      return startsWith(bytes, ...ascii('RIFF')) && Buffer.from(bytes.subarray(8, 12)).toString('latin1') === 'WEBP'
    case '.svg':
      return Buffer.from(bytes.subarray(0, 4096)).toString('utf8').includes('<svg')
    default:
      return false
  }
}

/**
 * Reads a branding file from the folder: it has to be inside it (also after following links), of an
 * allowed type and not too big. Returns its bytes and where pforte will serve it. The URL contains a
 * hash of the content, so a changed file is a new URL and browsers can keep the old one for a year.
 */
const readAsset = (dir: string, relative: unknown, where: string, allowed: string[], maxBytes: number) => {
  if (typeof relative !== 'string' || relative === '') throw new BrandError(`${where} must be the path of a file in the branding folder`)
  const root = realpathSync(dir)
  const wanted = resolve(root, relative)
  if (!existsSync(wanted)) throw new BrandError(`${where}: there is no file "${relative}" in the branding folder`)
  const file = realpathSync(wanted)
  if (file !== root && !file.startsWith(root + sep)) throw new BrandError(`${where}: "${relative}" is outside the branding folder`)
  const extension = extname(file).toLowerCase()
  if (!allowed.includes(extension)) throw new BrandError(`${where}: "${relative}" must be a ${allowed.join(', ')} file`)
  const size = statSync(file).size
  if (size > maxBytes) throw new BrandError(`${where}: "${relative}" is ${Math.ceil(size / 1024)} KB; the limit is ${Math.floor(maxBytes / 1024)} KB`)
  const bytes = readFileSync(file)
  if (!looksLike(extension, bytes)) throw new BrandError(`${where}: "${relative}" does not look like a ${extension.slice(1)} file`)
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 10)
  const name = basename(file).replace(/[^A-Za-z0-9._-]/g, '_')
  return { bytes, extension, path: `${hash}/${name}` }
}

const parseColors = (value: unknown, colors: Theme['colors']) => {
  if (!isRecord(value)) throw new BrandError('"colors" must be an object')
  onlyKnown(value, COLOR_KEYS, '"colors"')
  for (const [key, color] of Object.entries(value)) {
    if (typeof color !== 'string' || !HEX.test(color)) throw new BrandError(`"colors.${key}" must be a hex colour such as #162438`)
    ;(colors as unknown as Record<string, string>)[key] = color.toLowerCase()
  }
}

const parseFont = (dir: string, value: unknown, where: string, assets: Asset[]): Font => {
  if (!isRecord(value)) throw new BrandError(`"${where}" must be an object with a family and files`)
  onlyKnown(value, ['family', 'files'], `"${where}"`)
  if (typeof value.family !== 'string' || !FAMILY.test(value.family)) {
    throw new BrandError(`"${where}.family" must be a font name of letters, digits, spaces, - and _ (at most 40 characters)`)
  }
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > 6) {
    throw new BrandError(`"${where}.files" must list one to six font files`)
  }
  const files = value.files.map((entry, index): FontFile => {
    const at = `${where}.files[${index}]`
    if (!isRecord(entry)) throw new BrandError(`"${at}" must be an object with a file and a weight`)
    onlyKnown(entry, ['file', 'weight', 'style'], `"${at}"`)
    const weight = entry.weight ?? 400
    if (typeof weight !== 'number' || !Number.isInteger(weight) || weight < 100 || weight > 900 || weight % 100 !== 0) {
      throw new BrandError(`"${at}.weight" must be 100, 200 … 900`)
    }
    const style = entry.style ?? 'normal'
    if (style !== 'normal' && style !== 'italic') throw new BrandError(`"${at}.style" must be "normal" or "italic"`)
    const asset = readAsset(dir, entry.file, `"${at}.file"`, Object.keys(FONT_FORMATS), MAX_FONT_BYTES)
    const kind = FONT_FORMATS[asset.extension]!
    if (!assets.some((existing) => existing.path === asset.path)) assets.push({ path: asset.path, type: kind.type, bytes: asset.bytes })
    return { url: `/brand/${asset.path}`, weight, style, format: kind.format }
  })
  return { family: value.family, files }
}

const parseLinks = (value: unknown): FooterLink[] => {
  if (!Array.isArray(value) || value.length > MAX_LINKS) throw new BrandError(`"links" must be a list of at most ${MAX_LINKS} links`)
  return value.map((entry, index) => {
    const at = `links[${index}]`
    if (!isRecord(entry)) throw new BrandError(`"${at}" must be an object with a label and a url`)
    onlyKnown(entry, ['label', 'url'], `"${at}"`)
    const { label, url } = entry
    if (typeof label === 'string') {
      if (label.trim() === '') throw new BrandError(`"${at}.label" must not be empty`)
    } else if (isRecord(label) && Object.keys(label).length > 0 && Object.values(label).every((text) => typeof text === 'string' && text.trim() !== '')) {
      if (!('en' in label)) throw new BrandError(`"${at}.label" needs an "en" text, which is used for languages you do not list`)
    } else {
      throw new BrandError(`"${at}.label" must be a text, or an object with a text per language`)
    }
    let parsed: URL | undefined
    try {
      parsed = typeof url === 'string' ? new URL(url) : undefined
    } catch {
      parsed = undefined
    }
    if (!parsed || !['https:', 'mailto:'].includes(parsed.protocol)) throw new BrandError(`"${at}.url" must be an https:// or mailto: address`)
    return { label: label as FooterLink['label'], url: parsed.href }
  })
}

/**
 * Reads `<dir>/brand.json` and the files it names. A folder without `brand.json` has no branding and
 * gets the neutral look. Any mistake stops the start with a message that says what to change.
 */
export const loadBrand = (dir: string): Brand => {
  const file = join(dir, 'brand.json')
  const theme = defaultTheme()
  if (!existsSync(file)) return { theme, warnings: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new BrandError(`not valid JSON (${(error as Error).message})`)
  }
  if (!isRecord(parsed)) throw new BrandError('must be a JSON object')
  onlyKnown(parsed, TOP_LEVEL, 'the file')

  let name: string | undefined
  if (parsed.name !== undefined) {
    if (typeof parsed.name !== 'string' || parsed.name.trim() === '' || parsed.name.length > 80) throw new BrandError('"name" must be a text of up to 80 characters')
    name = parsed.name.trim()
    theme.name = name
  }

  if (parsed.colors !== undefined) parseColors(parsed.colors, theme.colors)

  if (parsed.radius !== undefined) {
    const match = typeof parsed.radius === 'string' ? RADIUS.exec(parsed.radius) : null
    if (!match || (match[2] === 'px' ? Number(match[1]) > 32 : Number(match[1]) > 2)) throw new BrandError('"radius" must be like 8px or 0.5rem, at most 32px')
    theme.radius = parsed.radius as string
  }

  if (parsed.logo !== undefined) {
    const logo = readAsset(dir, parsed.logo, '"logo"', Object.keys(LOGO_TYPES), MAX_LOGO_BYTES)
    theme.assets.push({ path: logo.path, type: LOGO_TYPES[logo.extension]!, bytes: logo.bytes })
    theme.logoUrl = `/brand/${logo.path}`
  }

  if (parsed.fonts !== undefined) {
    if (!isRecord(parsed.fonts)) throw new BrandError('"fonts" must be an object')
    onlyKnown(parsed.fonts, ['body', 'heading'], '"fonts"')
    if (parsed.fonts.body !== undefined) theme.fonts.body = parseFont(dir, parsed.fonts.body, 'fonts.body', theme.assets)
    if (parsed.fonts.heading !== undefined) theme.fonts.heading = parseFont(dir, parsed.fonts.heading, 'fonts.heading', theme.assets)
  }

  if (parsed.links !== undefined) theme.links = parseLinks(parsed.links)

  return { theme, name, warnings: contrastWarnings(theme) }
}
