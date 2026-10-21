import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BrokenLinkError, createLinkResolver, REPOSITORY } from './links.js'

describe('where a link of a document goes', () => {
  let root: string
  const pages = new Map([
    ['docs/security.md', { url: '/security/' }],
    ['docs/index.md', { url: '/' }],
    ['examples/production/README.md', { url: '/production/' }],
  ])
  let resolve: ReturnType<typeof createLinkResolver>

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'site-links-'))
    for (const file of ['docs/security.md', 'docs/index.md', 'CONTRIBUTING.md', 'examples/production/README.md', 'examples/relying-party/src/server.ts']) {
      mkdirSync(join(root, file, '..'), { recursive: true })
      writeFileSync(join(root, file), 'x')
    }
    resolve = createLinkResolver(root, pages)
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('goes to the page of another document, with its anchor', () => {
    expect(resolve('docs/index.md', 'security.md')).toBe('/security/')
    expect(resolve('docs/index.md', 'security.md#weak-secrets')).toBe('/security/#weak-secrets')
    expect(resolve('docs/index.md', './security.md')).toBe('/security/')
    expect(resolve('examples/production/README.md', '../../docs/security.md#x')).toBe('/security/#x')
    expect(resolve('docs/security.md', 'index.md')).toBe('/')
  })

  it('goes to GitHub for a file or a folder of the repository that is not a page', () => {
    expect(resolve('docs/security.md', '../CONTRIBUTING.md')).toBe(`${REPOSITORY}/blob/main/CONTRIBUTING.md`)
    expect(resolve('docs/security.md', '../CONTRIBUTING.md#set-up')).toBe(`${REPOSITORY}/blob/main/CONTRIBUTING.md#set-up`)
    expect(resolve('docs/index.md', '../examples/relying-party')).toBe(`${REPOSITORY}/tree/main/examples/relying-party`)
    expect(resolve('docs/index.md', '../examples/relying-party/')).toBe(`${REPOSITORY}/tree/main/examples/relying-party`)
    expect(resolve('docs/index.md', '../examples/relying-party/src/server.ts')).toBe(`${REPOSITORY}/blob/main/examples/relying-party/src/server.ts`)
  })

  it('leaves other sites, mail addresses and anchors of the same page alone', () => {
    for (const href of ['https://example.com/a?b=c#d', 'mailto:security@example.com', '#section', '//cdn.example.com/x']) {
      expect(resolve('docs/index.md', href)).toBe(href)
    }
  })

  it('refuses a link to something that does not exist, so that a rename cannot leave a dead link', () => {
    expect(() => resolve('docs/index.md', 'gone.md')).toThrow(BrokenLinkError)
    expect(() => resolve('docs/index.md', 'gone.md')).toThrow(/docs\/gone\.md, which does not exist/)
  })

  it('refuses a link that leaves the repository', () => {
    expect(() => resolve('docs/index.md', '../../outside.md')).toThrow(/leaves the repository/)
  })
})
