import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSite, defaultRepositoryRoot, latestRelease, type BuildResult } from './build.js'
import { navigation, notPublished } from './navigation.js'

describe('the site of this repository', () => {
  let outDir: string
  let result: BuildResult
  const html = (path: string) => readFileSync(join(outDir, path), 'utf8')
  const pageFiles = () => result.pages.map((page) => ({ ...page, file: page.slug === '' ? 'index.html' : `${page.slug}/index.html` }))

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), 'site-build-'))
    result = buildSite({ outDir })
  })

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true })
  })

  it('has a page for every entry of the navigation, and the files a site needs', () => {
    expect(result.pages).toHaveLength(navigation.flatMap((group) => group.pages).length)
    for (const file of ['index.html', '404.html', 'style.css', 'favicon.svg', 'sitemap.xml', 'robots.txt', 'CNAME', '.nojekyll']) expect(existsSync(join(outDir, file))).toBe(true)
    expect(html('CNAME').trim()).toBe('pforte.dev')
    for (const page of pageFiles()) expect(existsSync(join(outDir, page.file)), page.file).toBe(true)
  })

  it('has every document of docs/ in the navigation, unless it is listed as not published', () => {
    const documents = readdirSync(join(defaultRepositoryRoot, 'docs')).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`)
    const published = result.pages.map((page) => page.source)

    expect(documents.filter((source) => !published.includes(source) && !(source in notPublished))).toEqual([])
  })

  it('gives every page one title, a description and the menu with itself marked', () => {
    for (const page of pageFiles()) {
      const content = html(page.file)
      expect(content.match(/<h1[ >]/g), page.file).toHaveLength(1)
      expect(content).toMatch(/<meta name="description" content="[^"]{20,}"/)
      expect(content).toContain(`<a href="${page.url}" aria-current="page">`)
      expect(content).toContain(`<link rel="canonical" href="https://pforte.dev${page.url}">`)
    }
  })

  it('sends no script and asks nothing of other sites: no fonts, styles, images or frames from elsewhere', () => {
    for (const page of [...pageFiles().map((p) => p.file), '404.html']) {
      const content = html(page)
      expect(content, page).not.toMatch(/<script/i)
      expect(content, page).not.toMatch(/<(?:img|iframe|source|video|audio)[^>]+src="(?:https?:)?\/\//i)
      expect(content, page).not.toMatch(/<link[^>]+href="(?:https?:)?\/\/(?!pforte\.dev\/)/i)  // the canonical address is the only link to an address
    }
    expect(html('style.css')).not.toMatch(/url\(|@import/)
  })

  it('links only to pages and anchors that exist', () => {
    const idsOf = new Map(result.pages.map((page) => [page.url, new Set(page.ids)]))
    const broken: string[] = []
    for (const page of pageFiles()) {
      for (const [, href] of html(page.file).matchAll(/<a [^>]*href="([^"]+)"/g)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(href!)) continue
        const [path, hash] = href!.startsWith('#') ? [page.url, href!.slice(1)] : href!.split('#')
        const exists = idsOf.has(path!) || (path!.includes('.') && existsSync(join(outDir, path!)))
        if (!exists) broken.push(`${page.url}: ${href}`)
        else if (hash && hash !== 'content' && idsOf.has(path!) && !idsOf.get(path!)!.has(hash)) broken.push(`${page.url}: ${href} (no such section)`)
      }
    }

    expect(broken.join('\n')).toBe('')
  })

  it('links to the repository for files that are not pages', () => {
    expect(html('quick-start/index.html')).toContain('href="/changelog/"')
    expect(html('index.html')).toContain('href="https://github.com/progwise/pforte/tree/main/examples/relying-party"')
    expect(html('security/index.html')).toMatch(/href="https:\/\/github\.com\/progwise\/pforte\/blob\/main\/[^"]+"/)
  })

  it('names the sections of long pages at the top, and the previous and next page at the bottom', () => {
    expect(html('configuration/index.html')).toContain('<nav class="contents" aria-label="On this page">')
    expect(html('quick-start/index.html')).toContain('class="previous"')
    expect(html('quick-start/index.html')).toContain('class="next"')
    expect(html('index.html')).not.toContain('class="previous"')
    expect(html('index.html')).not.toContain('class="contents"')
  })

  it('says that it describes main, and names the latest release when there is one', () => {
    const release = latestRelease(readFileSync(join(defaultRepositoryRoot, 'CHANGELOG.md'), 'utf8'))
    const front = html('index.html')

    expect(front).toContain('describes the <code>main</code> branch')
    if (release) expect(front).toContain(`releases/tag/v${release}`)
  })

  it('lists every page in the sitemap, with the address of the site', () => {
    const sitemap = html('sitemap.xml')

    for (const page of result.pages) expect(sitemap).toContain(`<loc>https://pforte.dev${page.url}</loc>`)
  })

  it('has a page for an address that does not exist, which search engines leave out', () => {
    expect(html('404.html')).toContain('<meta name="robots" content="noindex">')
    expect(html('404.html')).toContain('Page not found')
  })

  it('is small: no page is larger than a few hundred kilobytes', () => {
    for (const page of pageFiles()) expect(statSync(join(outDir, page.file)).size, page.file).toBeLessThan(400_000)
  })
})

describe('the version of the latest release', () => {
  it('is the first dated entry of the changelog, not the unreleased one', () => {
    expect(latestRelease('## Unreleased\n\n- x\n\n## 0.2.0 (2026-11-01)\n\n## 0.1.0 (2026-10-21)\n')).toBe('0.2.0')
    expect(latestRelease('## Unreleased\n\n- x\n')).toBeUndefined()
    expect(latestRelease('## 0.3.0-rc.1 (2026-12-01)\n')).toBe('0.3.0-rc.1')
  })
})
