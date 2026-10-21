import { navigation, urlOf } from './navigation.js'
import type { Heading } from './markdown.js'

export interface PageModel {
  slug: string
  /** The file in the repository the page is made from. */
  source: string
  title: string
  menu: string
  description: string
  html: string
  headings: Heading[]
  /** Made from a data file, so there is no document to edit. */
  generated?: boolean
}

export interface SiteContext {
  siteUrl: string
  repository: string
  /** The version of the latest release, from the changelog. */
  release?: string
  commit: string
}

export const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const TAGLINE = 'A small, self-hosted OpenID Connect identity service for organisations whose users are managed by a back office.'

const menuLinks = (current: string, pages: Map<string, PageModel>) =>
  navigation
    .map(
      (group) => `<section>
<h2>${escapeHtml(group.title)}</h2>
<ul>
${group.pages
  .map((entry) => {
    const page = pages.get(entry.slug)!
    return `<li><a href="${urlOf(entry.slug)}"${entry.slug === current ? ' aria-current="page"' : ''}>${escapeHtml(page.menu)}</a></li>`
  })
  .join('\n')}
</ul>
</section>`,
    )
    .join('\n')

const orderedSlugs = navigation.flatMap((group) => group.pages.map((entry) => entry.slug))

const siblings = (slug: string, pages: Map<string, PageModel>) => {
  const index = orderedSlugs.indexOf(slug)
  const previous = index > 0 ? pages.get(orderedSlugs[index - 1]!) : undefined
  const next = index >= 0 && index < orderedSlugs.length - 1 ? pages.get(orderedSlugs[index + 1]!) : undefined
  if (!previous && !next) return ''
  return `<nav class="siblings" aria-label="Previous and next page">
${previous ? `<a class="previous" href="${urlOf(previous.slug)}"><span>Previous</span>${escapeHtml(previous.menu)}</a>` : '<span></span>'}
${next ? `<a class="next" href="${urlOf(next.slug)}"><span>Next</span>${escapeHtml(next.menu)}</a>` : '<span></span>'}
</nav>`
}

/** A list of the sections of a long page, under its title. */
const contents = (page: PageModel) => {
  if (page.slug === '') return '' // the front page is read from the top
  const sections = page.headings.filter((heading) => heading.level === 2)
  if (sections.length < 4) return ''
  return `<nav class="contents" aria-label="On this page"><p>On this page</p><ul>${sections.map((heading) => `<li><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`).join('')}</ul></nav>`
}

const banner = (context: SiteContext) =>
  `<p class="banner">This documentation describes the <code>main</code> branch of pforte.${context.release ? ` The latest release is <a href="${context.repository}/releases/tag/v${escapeHtml(context.release)}">${escapeHtml(context.release)}</a>.` : ''}</p>`

export const renderLayout = (page: PageModel, pages: Map<string, PageModel>, context: SiteContext, { notFound = false } = {}) => {
  const url = `${context.siteUrl}${urlOf(page.slug)}`
  const title = page.slug === '' ? `pforte: ${TAGLINE.replace(/\.$/, '').replace(/^A small, /, 'a small, ')}` : `${page.title} · pforte`
  const description = page.slug === '' ? TAGLINE : page.description
  const content = page.html.replace(/<\/h1>/, `</h1>\n${contents(page)}`)
  const editUrl = `${context.repository}/edit/main/${page.source}`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
${notFound ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${escapeHtml(url)}">`}
<meta property="og:type" content="website">
<meta property="og:site_name" content="pforte">
<meta property="og:title" content="${escapeHtml(page.slug === '' ? 'pforte' : page.title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(url)}">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<a class="skip" href="#content">Skip to the content</a>
<header class="top">
<a class="brand" href="/">pforte</a>
<nav aria-label="Project">
<a href="/quick-start/">Quick start</a>
<a href="${context.repository}">GitHub</a>
</nav>
</header>
<details class="menu">
<summary>Menu</summary>
<nav aria-label="Documentation">
${menuLinks(page.slug, pages)}
</nav>
</details>
<div class="layout">
<nav class="side" aria-label="Documentation">
${menuLinks(page.slug, pages)}
</nav>
<main id="content">
${banner(context)}
<article>
${content}
</article>
${notFound ? '' : siblings(page.slug, pages)}
<p class="edit">${page.generated ? `This page is made from <a href="${context.repository}/blob/main/${escapeHtml(page.source)}">${escapeHtml(page.source)}</a>, which the tests keep in step with the code.` : `<a href="${escapeHtml(editUrl)}">Edit this page on GitHub</a>`}</p>
</main>
</div>
<footer>
<p>pforte is open source under the <a href="${context.repository}/blob/main/LICENSE">Apache License 2.0</a>. Built from <a href="${context.repository}/commit/${escapeHtml(context.commit)}">${escapeHtml(context.commit.slice(0, 7))}</a>.</p>
</footer>
</body>
</html>
`
}
