import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadBrand } from './brand.js'
import { darkColors, DEFAULT_COLORS } from './theme.js'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
const WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(40, 1)])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)])

/** A branding folder with the given files; `brand` is written as brand.json. */
const folder = (brand: unknown, files: Record<string, string | Buffer> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'pforte-brand-'))
  mkdirSync(join(dir, 'fonts'))
  writeFileSync(join(dir, 'logo.svg'), SVG)
  writeFileSync(join(dir, 'fonts', 'Body-Regular.woff2'), WOFF2)
  writeFileSync(join(dir, 'fonts', 'Body-Bold.woff2'), Buffer.concat([WOFF2, Buffer.from('bold')]))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  if (brand !== undefined) writeFileSync(join(dir, 'brand.json'), typeof brand === 'string' ? brand : JSON.stringify(brand))
  return dir
}

const full = {
  name: 'Example Inc.',
  logo: 'logo.svg',
  radius: '16px',
  colors: { background: '#F7F4EC', primary: '#e6e448', primaryText: '#162438', text: '#162438', link: '#2A4A6B', muted: '#4a5666' },
  fonts: {
    body: {
      family: 'Example Sans',
      files: [
        { file: 'fonts/Body-Regular.woff2', weight: 400 },
        { file: 'fonts/Body-Bold.woff2', weight: 700 },
      ],
    },
    heading: { family: 'Example Display', files: [{ file: 'fonts/Body-Bold.woff2', weight: 600, style: 'italic' }] },
  },
  links: [
    { label: { en: 'Imprint', de: 'Impressum' }, url: 'https://example.com/imprint' },
    { label: 'Privacy', url: 'https://example.com/privacy' },
    { label: 'Help', url: 'mailto:help@example.com' },
  ],
}

describe('the branding folder', () => {
  it('has the neutral look without a brand.json', () => {
    const brand = loadBrand(folder(undefined))
    expect(brand.theme.colors).toEqual(DEFAULT_COLORS)
    expect(brand.theme.assets.map((asset) => asset.path)).toEqual([expect.stringMatching(/^[0-9a-f]{10}\/pforte\.svg$/)])
    expect(brand.name).toBeUndefined()
    expect(brand.warnings).toEqual([])
  })

  it('reads everything a brand.json can hold', () => {
    const { theme, name, warnings } = loadBrand(folder(full))

    expect(name).toBe('Example Inc.')
    expect(theme.radius).toBe('16px')
    expect(theme.colors).toMatchObject({ background: '#f7f4ec', primary: '#e6e448', link: '#2a4a6b', surface: DEFAULT_COLORS.surface })
    expect(theme.links.map((link) => link.url)).toEqual(['https://example.com/imprint', 'https://example.com/privacy', 'mailto:help@example.com'])
    expect(theme.fonts.body).toMatchObject({ family: 'Example Sans' })
    expect(theme.fonts.body!.files.map((file) => [file.weight, file.style, file.format])).toEqual([
      [400, 'normal', 'woff2'],
      [700, 'normal', 'woff2'],
    ])
    expect(theme.fonts.heading!.files[0]).toMatchObject({ weight: 600, style: 'italic' })
    expect(warnings).toEqual([])
  })

  it('serves files under a path with the hash of their content, so a changed file has a new address', () => {
    const { theme } = loadBrand(folder(full))
    expect(theme.logoUrl).toMatch(/^\/brand\/[0-9a-f]{10}\/logo\.svg$/)
    const types = Object.fromEntries(theme.assets.map((asset) => [asset.path.split('/')[1], asset.type]))
    expect(types).toMatchObject({ 'logo.svg': 'image/svg+xml', 'Body-Regular.woff2': 'font/woff2' })
    // the bold file is used twice but kept once
    expect(theme.assets.filter((asset) => asset.path.endsWith('Body-Bold.woff2'))).toHaveLength(1)

    const changed = loadBrand(folder(full, { 'logo.svg': SVG.replace('10"', '12"') }))
    expect(changed.theme.logoUrl).not.toBe(theme.logoUrl)
  })

  it('shows its logo in the browser tab as well', () => {
    const { theme } = loadBrand(folder(full))
    expect(theme.iconUrl).toBe(theme.logoUrl)
    expect(theme.assets.some((asset) => asset.path.endsWith('pforte.svg'))).toBe(false)
  })

  it('keeps the signet for the browser tab without a logo, in its own colours, and shows the name above the pages', () => {
    const { theme } = loadBrand(folder({ name: 'Example Inc.', colors: { primary: '#e6e448', primaryText: '#162438' } }))
    expect(theme.logoUrl).toBeUndefined()
    expect(theme.iconUrl).toMatch(/^\/brand\/[0-9a-f]{10}\/pforte\.svg$/)
    const signet = Buffer.from(theme.assets.find((asset) => `/brand/${asset.path}` === theme.iconUrl)!.bytes).toString()
    expect(signet).toContain('fill="#e6e448"')
    expect(signet).toContain('fill="#162438"')
  })

  it('shows the signet above the pages too when there is neither a logo nor a name', () => {
    const { theme } = loadBrand(folder({ radius: '4px' }))
    expect(theme.logoUrl).toBe(theme.iconUrl)
    expect(theme.logoUrl).toMatch(/pforte\.svg$/)
  })

  describe('with a second, small logo', () => {
    const MARK = SVG.replace('viewBox="0 0 10 10"', 'viewBox="0 0 4 4"')
    const both = (brand: object = {}) => loadBrand(folder({ name: 'Example Inc.', logo: 'logo.svg', logoSmall: 'mark.svg', ...brand }, { 'mark.svg': MARK, 'mark.png': PNG }))

    it('serves both and keeps the first above the pages', () => {
      const { theme } = both()
      expect(theme.logoUrl).toMatch(/^\/brand\/[0-9a-f]{10}\/logo\.svg$/)
      expect(theme.logoSmallUrl).toMatch(/^\/brand\/[0-9a-f]{10}\/mark\.svg$/)
      expect(theme.assets.map((asset) => [`/brand/${asset.path}`, asset.type, Buffer.from(asset.bytes).toString()])).toEqual([
        [theme.logoUrl, 'image/svg+xml', SVG],
        [theme.logoSmallUrl, 'image/svg+xml', MARK],
      ])
    })

    it('shows the small one in the browser tab', () => {
      const { theme } = both()
      expect(theme.iconUrl).toBe(theme.logoSmallUrl)
      expect(theme.assets.some((asset) => asset.path.endsWith('pforte.svg'))).toBe(false)
    })

    it('may be of another type than the logo, or the same file', () => {
      expect(both({ logoSmall: 'mark.png' }).theme.assets.map((asset) => asset.type)).toEqual(['image/svg+xml', 'image/png'])
      const same = both({ logoSmall: 'logo.svg' }).theme
      expect(same.logoSmallUrl).toBe(same.logoUrl)
      expect(same.assets).toHaveLength(1)
    })

    it.each([
      ['alone: it is the small form of a logo', { logo: undefined }, /"logoSmall" is the small form of "logo"/],
      ['a file that is missing', { logoSmall: 'nope.svg' }, /"logoSmall": there is no file "nope.svg"/],
      ['a file of the wrong type', { logoSmall: 'brand.json' }, /"logoSmall": "brand.json" must be a .svg, .png/],
      ['a file that is not an image', { logoSmall: 'fake.png' }, /"logoSmall": "fake.png" does not look like a png file/],
      ['a file that is too big', { logoSmall: 'big.svg' }, /"logoSmall": "big.svg" is \d+ KB; the limit is 512 KB/],
      ['something that is no path', { logoSmall: true }, /"logoSmall" must be the path of a file/],
    ])('refuses it as %s', (_name, brand, message) => {
      const dir = folder({ name: 'Example Inc.', logo: 'logo.svg', logoSmall: 'mark.svg', ...brand }, { 'mark.svg': MARK, 'fake.png': 'not a png', 'big.svg': `${SVG}${' '.repeat(600 * 1024)}` })
      expect(() => loadBrand(dir)).toThrow(message)
    })
  })

  describe('the dark variant', () => {
    const colors = { primary: '#162438', primaryText: '#ffffff', link: '#2a4a6b' }

    it('is calculated from the colours of the brand when it says nothing', () => {
      const { theme, warnings } = loadBrand(folder({ colors }))
      expect(theme.dark).toEqual({ colors: darkColors({ ...DEFAULT_COLORS, ...colors }), logoTile: false })
      expect(theme.dark!.colors.primary).not.toBe('#162438')
      expect(warnings).toEqual([])
    })

    it('is there for a brand without colours of its own, and for a folder without a brand.json', () => {
      const neutral = { colors: darkColors(DEFAULT_COLORS), logoTile: false }
      expect(loadBrand(folder({ name: 'Example Inc.' })).theme.dark).toEqual(neutral)
      expect(loadBrand(folder(undefined)).theme.dark).toEqual(neutral)
    })

    it('keeps the logo on a light tile, because it was drawn for a light page, unless the brand says it reads on dark', () => {
      expect(loadBrand(folder({ logo: 'logo.svg' })).theme.dark!.logoTile).toBe(true)
      expect(loadBrand(folder({ logo: 'logo.svg', dark: {} })).theme.dark!.logoTile).toBe(true)
      expect(loadBrand(folder({ logo: 'logo.svg', dark: { logoTile: false } })).theme.dark!.logoTile).toBe(false)
      // The signet is drawn on its own tile.
      expect(loadBrand(folder({ dark: { logoTile: true } })).theme.dark!.logoTile).toBe(false)
    })

    it('takes single colours from the brand and calculates the rest', () => {
      const { theme } = loadBrand(folder({ colors, dark: { colors: { primary: '#F2C94C', primaryText: '#1d2b4a', surface: '#202020' } } }))
      expect(theme.dark!.colors).toEqual({ ...darkColors({ ...DEFAULT_COLORS, ...colors }), primary: '#f2c94c', primaryText: '#1d2b4a', surface: '#202020' })
      // The light colours are not touched.
      expect(theme.colors).toMatchObject(colors)
    })

    it('is switched off with false: the brand is light for everybody', () => {
      const { theme, warnings } = loadBrand(folder({ colors, logo: 'logo.svg', dark: false }))
      expect(theme.dark).toBeUndefined()
      expect(warnings).toEqual([])
    })

    it('warns about dark colours that cannot be read, and says that they are the dark ones', () => {
      const { warnings } = loadBrand(folder({ dark: { colors: { text: '#444444' } } }))
      expect(warnings).toHaveLength(2)
      expect(warnings[0]).toMatch(/^Low contrast for text on a dark page: \d\.\d:1/)
    })

    it.each([
      ['something that is neither false nor an object', { dark: true }, /"dark" must be false, or an object/],
      ['a list', { dark: [] }, /"dark" must be false, or an object/],
      ['an entry it does not know', { dark: { colours: {} } }, /"dark" has unknown entry "colours"/],
      ['a colour that is not hex', { dark: { colors: { primary: 'gold' } } }, /"dark.colors.primary" must be a hex colour/],
      ['a colour that could be CSS', { dark: { colors: { primary: '#fff; x: y' } } }, /"dark.colors.primary" must be a hex colour/],
      ['an unknown colour', { dark: { colors: { accent: '#fff' } } }, /"dark.colors" has unknown entry "accent"/],
      ['colours that are no object', { dark: { colors: '#000' } }, /"dark.colors" must be an object/],
      ['a tile that is neither yes nor no', { dark: { logoTile: 'yes' } }, /"dark.logoTile" must be true or false/],
    ])('refuses %s', (_name, brand, message) => {
      expect(() => loadBrand(folder(brand))).toThrow(message)
    })
  })

  it('accepts a raster logo', () => {
    const { theme } = loadBrand(folder({ logo: 'logo.png' }, { 'logo.png': PNG }))
    expect(theme.assets[0]!.type).toBe('image/png')
  })

  it('warns about colours that cannot be read', () => {
    const { warnings } = loadBrand(folder({ colors: { primary: '#ffff66', primaryText: '#ffffff' } }))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/main button.*1\.\d:1/)
  })

  it.each([
    ['not json', '{oops', /not valid JSON/],
    ['an array', '[]', /must be a JSON object/],
    ['a typo in a key', { colour: {} }, /unknown entry "colour"/],
    ['a name that is empty', { name: ' ' }, /"name" must be a text/],
    ['a colour that is not hex', { colors: { primary: 'red' } }, /"colors.primary" must be a hex colour/],
    ['a colour that could be CSS', { colors: { primary: '#fff; background: url(x)' } }, /must be a hex colour/],
    ['an unknown colour', { colors: { accent: '#fff' } }, /unknown entry "accent"/],
    ['a radius that is too big', { radius: '99px' }, /"radius" must be like/],
    ['a radius that is CSS', { radius: '8px; x: y' }, /"radius" must be like/],
    ['a missing logo', { logo: 'nope.svg' }, /there is no file "nope.svg"/],
    ['a logo of the wrong type', { logo: 'brand.json' }, /must be a .svg, .png/],
    ['a logo that is not an image', { logo: 'fake.png' }, /does not look like a png file/],
    ['a font name that could be CSS', { fonts: { body: { family: 'A"; x: y', files: [{ file: 'fonts/Body-Regular.woff2' }] } } }, /must be a font name/],
    ['no font files', { fonts: { body: { family: 'A', files: [] } } }, /one to six font files/],
    ['a font weight in between', { fonts: { body: { family: 'A', files: [{ file: 'fonts/Body-Regular.woff2', weight: 450 }] } } }, /weight/],
    ['a font style that does not exist', { fonts: { body: { family: 'A', files: [{ file: 'fonts/Body-Regular.woff2', style: 'oblique' }] } } }, /style/],
    ['a font that is not a font', { fonts: { body: { family: 'A', files: [{ file: 'fonts/fake.woff2' }] } } }, /does not look like a woff2 file/],
    ['an unknown font role', { fonts: { mono: {} } }, /unknown entry "mono"/],
    ['a link without https', { links: [{ label: 'x', url: 'http://example.com' }] }, /https:\/\/ or mailto:/],
    ['a script link', { links: [{ label: 'x', url: 'javascript:alert(1)' }] }, /https:\/\/ or mailto:/],
    ['a link without a label', { links: [{ label: '', url: 'https://example.com' }] }, /must not be empty/],
    ['labels without English', { links: [{ label: { de: 'Impressum' }, url: 'https://example.com' }] }, /needs an "en" text/],
    ['too many links', { links: Array.from({ length: 7 }, () => ({ label: 'x', url: 'https://example.com' })) }, /at most 6 links/],
  ])('refuses %s', (_name, brand, message) => {
    const dir = folder(brand, { 'fake.png': 'text, not an image', 'fonts/fake.woff2': 'text, not a font' })
    expect(() => loadBrand(dir)).toThrow(message)
    expect(() => loadBrand(dir)).toThrow(/^brand\.json: /)
  })

  it('refuses files outside the folder, also through a link', () => {
    const outside = mkdtempSync(join(tmpdir(), 'pforte-outside-'))
    writeFileSync(join(outside, 'secret.svg'), SVG)
    expect(() => loadBrand(folder({ logo: '../' + outside.split('/').pop() + '/secret.svg' }))).toThrow(/outside the branding folder/)

    const dir = folder({ logo: 'link.svg' })
    symlinkSync(join(outside, 'secret.svg'), join(dir, 'link.svg'))
    expect(() => loadBrand(dir)).toThrow(/outside the branding folder/)
  })

  it('refuses files that are too big', () => {
    expect(() => loadBrand(folder({ logo: 'big.svg' }, { 'big.svg': `${SVG}${' '.repeat(600 * 1024)}` }))).toThrow(/limit is 512 KB/)
  })
})
