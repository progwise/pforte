import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrokenLinkError, createLinkResolver, REPOSITORY } from './links.js'
import { escapeHtml, renderLayout, type PageModel, type SiteContext } from './layout.js'
import { renderMarkdown } from './markdown.js'
import { renderOpenApi, type OpenApiDocument } from './openapi.js'
import { navigation, notPublished, urlOf } from './navigation.js'

export const SITE_URL = 'https://pforte.dev'

const here = dirname(fileURLToPath(import.meta.url))
export const defaultRepositoryRoot = join(here, '..', '..')

const currentCommit = (repositoryRoot: string) => {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

/** The version of the latest release: the first entry of the changelog that has a date. */
export const latestRelease = (changelog: string) => /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?) \(\d{4}-\d{2}-\d{2}\)/m.exec(changelog)?.[1]

export interface BuildResult {
  outDir: string
  pages: { slug: string; url: string; title: string; source: string; ids: string[] }[]
}

/** Builds the whole site into `outDir`. Throws with every problem at once: a broken link, a missing page, a document that is not in the menu. */
export const buildSite = ({ repositoryRoot = defaultRepositoryRoot, outDir = join(here, '..', 'dist') }: { repositoryRoot?: string; outDir?: string } = {}): BuildResult => {
  const problems: string[] = []
  const entries = navigation.flatMap((group) => group.pages)

  for (const file of readdirSync(join(repositoryRoot, 'docs')).filter((name) => name.endsWith('.md'))) {
    const source = `docs/${file}`
    if (!entries.some((entry) => entry.source === source) && !(source in notPublished)) {
      problems.push(`${source} is not in the navigation (site/src/navigation.ts). Add it, or list it in notPublished with the reason.`)
    }
  }

  const pagesBySource = new Map(entries.map((entry) => [entry.source, { url: urlOf(entry.slug) }]))
  const resolve = createLinkResolver(repositoryRoot, pagesBySource)
  const safeResolve = (source: string, href: string) => {
    try {
      return resolve(source, href)
    } catch (error) {
      if (!(error instanceof BrokenLinkError)) throw error
      problems.push(error.message)
      return href
    }
  }

  const models = new Map<string, PageModel>()
  const resolvedLinks = new Map<string, string[]>()
  for (const entry of entries) {
    const path = join(repositoryRoot, entry.source)
    if (!existsSync(path)) {
      problems.push(`${entry.source} is in the navigation but does not exist`)
      continue
    }
    const rendered =
      entry.generated === 'openapi'
        ? (() => {
            const reference = renderOpenApi(JSON.parse(readFileSync(path, 'utf8')) as OpenApiDocument)
            return { html: reference.html, headings: reference.headings, summary: reference.summary, links: [] as string[] }
          })()
        : renderMarkdown(readFileSync(path, 'utf8'), (href) => safeResolve(entry.source, href))
    const title = rendered.headings.find((heading) => heading.level === 1)?.text
    if (!title) {
      problems.push(`${entry.source} has no title (a heading of level 1)`)
      continue
    }
    models.set(entry.slug, {
      slug: entry.slug,
      source: entry.source,
      title,
      menu: entry.menu ?? title,
      description: rendered.summary,
      html: rendered.html,
      headings: rendered.headings,
      generated: entry.generated !== undefined,
    })
    resolvedLinks.set(entry.slug, rendered.links.map((href) => safeResolve(entry.source, href)))
  }

  // An anchor must exist on the page it points to: on this page, or on another page of the site.
  const bySlugUrl = new Map([...models.values()].map((page) => [urlOf(page.slug), page]))
  for (const [slug, links] of resolvedLinks) {
    const page = models.get(slug)!
    for (const link of links) {
      const hashAt = link.indexOf('#')
      if (hashAt === -1 || /^[a-z][a-z0-9+.-]*:/i.test(link)) continue
      const target = link.startsWith('#') ? page : bySlugUrl.get(link.slice(0, hashAt))
      if (!target) continue
      const id = link.slice(hashAt + 1)
      if (id && !target.headings.some((heading) => heading.id === id)) problems.push(`${page.source}: the link "${link}" points to a section that ${target.source} does not have`)
    }
  }

  if (problems.length > 0) throw new Error(`The site cannot be built:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`)

  const changelogPath = join(repositoryRoot, 'CHANGELOG.md')
  const context: SiteContext = {
    siteUrl: SITE_URL,
    repository: REPOSITORY,
    release: existsSync(changelogPath) ? latestRelease(readFileSync(changelogPath, 'utf8')) : undefined,
    commit: currentCommit(repositoryRoot),
  }

  rmSync(outDir, { recursive: true, force: true })
  const write = (path: string, content: string) => {
    const target = join(outDir, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }

  const pages = [...models.values()]
  for (const page of pages) write(page.slug === '' ? 'index.html' : `${page.slug}/index.html`, renderLayout(page, models, context))

  const notFound: PageModel = {
    slug: 'not-found',
    source: 'docs/index.md',
    title: 'Page not found',
    menu: 'Page not found',
    description: 'This page does not exist.',
    html: '<h1>Page not found</h1>\n<p>This page does not exist, or it has moved. Start from <a href="/">the front page</a> or the menu.</p>\n',
    headings: [],
  }
  write('404.html', renderLayout(notFound, models, context, { notFound: true }))
  write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((page) => `<url><loc>${escapeHtml(SITE_URL + urlOf(page.slug))}</loc></url>`).join('\n')}\n</urlset>\n`)
  write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`)
  write('CNAME', 'pforte.dev\n')
  write('.nojekyll', '')
  copyFileSync(join(here, 'style.css'), join(outDir, 'style.css'))
  copyFileSync(join(here, 'favicon.svg'), join(outDir, 'favicon.svg'))
  copyFileSync(join(repositoryRoot, 'docs', 'openapi.json'), join(outDir, 'openapi.json'))

  return { outDir, pages: pages.map((page) => ({ slug: page.slug, url: urlOf(page.slug), title: page.title, source: page.source, ids: page.headings.map((heading) => heading.id) })) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = buildSite()
    console.log(`Built ${result.pages.length} pages into ${result.outDir}`)
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }
}
