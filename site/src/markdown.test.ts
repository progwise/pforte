import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown.js'

const render = (source: string, resolve = (href: string) => href) => renderMarkdown(source, resolve)

describe('rendering a document', () => {
  it('gives headings the ids of GitHub and lists them', () => {
    const result = render('# Title\n\n## First section\n\n### Detail\n\n## First section\n')

    expect(result.html).toContain('<h2 id="first-section">First section</h2>')
    expect(result.html).toContain('<h2 id="first-section-1">First section</h2>')
    expect(result.headings.map((heading) => [heading.level, heading.id])).toEqual([[1, 'title'], [2, 'first-section'], [3, 'detail'], [2, 'first-section-1']])
  })

  it('uses the text of a heading, not its code marks', () => {
    expect(render('## The `ISSUER` setting\n').headings[0]).toMatchObject({ text: 'The ISSUER setting', id: 'the-issuer-setting' })
  })

  it('shows raw HTML as text instead of passing it on', () => {
    const { html } = render('Text <script>alert(1)</script> and <img src=x onerror=alert(1)>\n')

    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
  })

  it('lets a table scroll on its own', () => {
    expect(render('| a | b |\n| - | - |\n| 1 | 2 |\n').html).toMatch(/<div class="table"><table>[\s\S]*<\/table><\/div>/)
  })

  it('marks code for the language and lets it be reached by the keyboard, with escaped content', () => {
    const { html } = render('```sh\necho "<b>" && ls\n```\n')

    expect(html).toContain('<pre tabindex="0"><code class="language-sh">')
    expect(html).toContain('echo &quot;&lt;b&gt;&quot; &amp;&amp; ls')
  })

  it('asks the resolver where every link goes, and reports the links as written', () => {
    const result = render('[a](one.md) and [b](two.md#x) and <https://example.com>\n', (href) => `/resolved/${href}`)

    expect(result.links).toEqual(['one.md', 'two.md#x', 'https://example.com'])
    expect(result.html).toContain('href="/resolved/one.md"')
    expect(result.html).toContain('href="/resolved/two.md#x"')
  })

  it('takes the first paragraph, as plain text, for the description', () => {
    expect(render('# T\n\nA **bold** start with `code` and a [link](x).\n\nSecond.\n').summary).toBe('A bold start with code and a link.')
  })

  it('does not take a list item for the description', () => {
    expect(render('# T\n\n- item\n\nThe paragraph.\n').summary).toBe('The paragraph.')
  })
})
