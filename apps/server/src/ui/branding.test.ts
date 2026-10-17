import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { loadBrand } from './brand.js'
import { brandRoutes } from './brand-routes.js'
import { createUi } from './index.js'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
const WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(40, 7)])

const branded = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pforte-branding-'))
  mkdirSync(join(dir, 'fonts'))
  writeFileSync(join(dir, 'logo.svg'), SVG)
  writeFileSync(join(dir, 'fonts', 'Sans.woff2'), WOFF2)
  writeFileSync(
    join(dir, 'brand.json'),
    JSON.stringify({
      name: 'Example <Inc.>',
      logo: 'logo.svg',
      colors: { primary: '#e6e448', primaryText: '#162438', background: '#f7f4ec' },
      fonts: { body: { family: 'Example Sans', files: [{ file: 'fonts/Sans.woff2', weight: 400 }] } },
      links: [
        { label: { en: 'Imprint', de: 'Impressum', fr: 'Mentions légales' }, url: 'https://example.com/imprint?a=1&b=2' },
        { label: 'Privacy', url: 'https://example.com/privacy' },
      ],
    }),
  )
  const { theme } = loadBrand(dir)
  return { theme, ui: createUi({ theme }) }
}

describe('pages with a theme', () => {
  const { theme, ui } = branded()
  const html = ui.pages.for('de').login({ uid: 'u1' })

  it('show the logo with the name as its description, escaped', () => {
    expect(html).toContain(`<img class="logo" src="${theme.logoUrl}" alt="Example &lt;Inc.&gt;">`)
    expect(html).not.toContain('<Inc.>')
  })

  it('show only the name where there is no logo', () => {
    const nameOnly = createUi({ theme: { ...theme, logoUrl: undefined } }).pages.for('en').login({ uid: 'u1' })
    expect(nameOnly).toContain('<p class="brand">Example &lt;Inc.&gt;</p>')
    expect(nameOnly).not.toContain('<img')
  })

  it('show nothing of the kind without branding', () => {
    const plain = createUi().pages.for('en').login({ uid: 'u1' })
    expect(plain).not.toContain('class="logo"')
    expect(plain).not.toContain('class="brand"')
    expect(plain).not.toContain('class="links"')
  })

  it('list the footer links in the language of the page, with English for the rest', () => {
    expect(html).toContain('<a href="https://example.com/imprint?a=1&amp;b=2">Impressum</a>')
    expect(html).toContain('>Privacy</a>')
    expect(ui.pages.for('fr').login({ uid: 'u' })).toContain('>Mentions légales</a>')
    expect(ui.pages.for('hu').login({ uid: 'u' })).toContain('>Imprint</a>')
  })

  it('carry the stylesheet and fonts of the theme', () => {
    expect(html).toContain('--primary: #e6e448')
    expect(html).toContain('@font-face { font-family: "Example Sans"')
  })

  it('send a policy that matches the stylesheet in the page, and opens only our own fonts and logo', async () => {
    const app = Fastify()
    await app.register(async (scope) => {
      ui.pages.addHeaders(scope)
      scope.get('/page', async (_request, reply) => reply.type('text/html').send(html))
    })
    const response = await app.inject({ url: '/page' })
    const css = /<style>([\s\S]*?)<\/style>/.exec(response.body)![1]!
    const hash = createHash('sha256').update(css).digest('base64')

    expect(response.headers['content-security-policy']).toContain(`style-src 'sha256-${hash}'`)
    expect(response.headers['content-security-policy']).toContain("font-src 'self'")
    expect(response.headers['content-security-policy']).toContain("img-src 'self'")
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['referrer-policy']).toBe('no-referrer')
  })
})

describe('serving the logo and the fonts', () => {
  const { theme, ui } = branded()
  const app = buildApp({ getDatabaseTime: async () => new Date(), ui })

  it('serves the logo for a year, as an image that cannot run anything', async () => {
    const response = await app.inject({ url: theme.logoUrl! })
    expect(response.statusCode).toBe(200)
    expect(response.body).toBe(SVG)
    expect(response.headers['content-type']).toContain('image/svg+xml')
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['content-security-policy']).toContain('sandbox')
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin')
  })

  it('serves a font with its type', async () => {
    const url = /url\("([^"]+)"\)/.exec(buildCssOf(ui))![1]!
    const response = await app.inject({ url })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('font/woff2')
    expect(Buffer.from(response.rawPayload).equals(WOFF2)).toBe(true)
  })

  it.each(['/brand/', '/brand/nothing/here.svg', '/brand/..%2f..%2fetc%2fpasswd', '/brand/abcdef0123/../logo.svg', '/brand/%2e%2e/%2e%2e/etc/passwd'])(
    'does not find %s: only files read at startup exist',
    async (url) => {
      const response = await app.inject({ url })
      expect(response.statusCode).toBe(404)
    },
  )

  it('adds no route without branding files', async () => {
    const plain = buildApp({ getDatabaseTime: async () => new Date(), ui: createUi() })
    expect((await plain.inject({ url: '/brand/x/y.svg' })).statusCode).toBe(404)
  })

  it('can be registered on its own', async () => {
    const own = Fastify()
    await own.register(brandRoutes(theme.assets))
    expect((await own.inject({ url: theme.logoUrl! })).statusCode).toBe(200)
  })
})

const buildCssOf = (ui: ReturnType<typeof createUi>) => ui.pages.for('en').login({ uid: 'u' })
