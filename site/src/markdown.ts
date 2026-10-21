import MarkdownIt from 'markdown-it'
import { createSlugger } from './slug.js'

export interface Heading {
  level: number
  text: string
  id: string
}

export interface Rendered {
  html: string
  headings: Heading[]
  /** The first paragraph as plain text, for the description of the page. */
  summary: string
  /** Every link of the document as written, so that they can be checked. */
  links: string[]
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Turns a Markdown document into HTML. Raw HTML in the document is shown as text, not passed on. Headings get the ids of
 * GitHub, tables can scroll on their own, and `resolveLink` decides where each link goes.
 */
export const renderMarkdown = (source: string, resolveLink: (href: string) => string): Rendered => {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false })
  const headings: Heading[] = []
  const links: string[] = []
  let summary = ''
  const slug = createSlugger()

  md.core.ruler.push('pforte', (state) => {
    const tokens = state.tokens
    tokens.forEach((token, index) => {
      if (token.type === 'heading_open') {
        const text = (tokens[index + 1]?.children ?? []).map((child) => (child.type === 'text' || child.type === 'code_inline' ? child.content : '')).join('')
        const id = slug(text)
        token.attrSet('id', id)
        headings.push({ level: Number(token.tag.slice(1)), text, id })
      }
      if (token.type === 'paragraph_open' && !summary && tokens[index - 1]?.type !== 'list_item_open') {
        summary = (tokens[index + 1]?.children ?? []).map((child) => (child.type === 'text' || child.type === 'code_inline' ? child.content : child.type === 'softbreak' ? ' ' : '')).join('').trim()
      }
      if (token.type === 'inline') {
        for (const child of token.children ?? []) {
          if (child.type === 'link_open') {
            const href = child.attrGet('href') ?? ''
            links.push(href)
            child.attrSet('href', resolveLink(href))
          }
        }
      }
    })
  })

  md.renderer.rules.table_open = () => '<div class="table"><table>\n'
  md.renderer.rules.table_close = () => '</table></div>\n'
  md.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index]!
    const language = token.info.trim().split(/\s+/)[0] ?? ''
    return `<pre tabindex="0"><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(token.content)}</code></pre>\n`
  }

  return { html: md.render(source), headings, summary, links }
}
