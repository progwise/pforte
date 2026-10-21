import { existsSync, statSync } from 'node:fs'
import { posix, join } from 'node:path'

export const REPOSITORY = 'https://github.com/progwise/pforte'

export interface LinkTarget {
  /** Where the page of this source file is on the site, such as `/security/`. */
  url: string
}

export class BrokenLinkError extends Error {}

/**
 * Decides where a link of a document goes. A link to another document of the site goes to its page, a link to anything else in
 * the repository goes to GitHub, and a link to something that does not exist is an error, so that a renamed file cannot leave a
 * dead link behind. Links to other sites and to anchors of the same page stay as they are.
 */
export const createLinkResolver = (repositoryRoot: string, pagesBySource: Map<string, LinkTarget>) => (source: string, href: string) => {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#') || href === '') return href

  const hashAt = href.indexOf('#')
  const path = hashAt === -1 ? href : href.slice(0, hashAt)
  const hash = hashAt === -1 ? '' : href.slice(hashAt)
  const resolved = posix.normalize(posix.join(posix.dirname(source), path))
  if (resolved.startsWith('..')) throw new BrokenLinkError(`${source}: the link "${href}" leaves the repository`)

  const page = pagesBySource.get(resolved)
  if (page) return `${page.url}${hash}`

  const absolute = join(repositoryRoot, resolved)
  if (!existsSync(absolute)) throw new BrokenLinkError(`${source}: the link "${href}" points to ${resolved}, which does not exist`)
  const kind = statSync(absolute).isDirectory() ? 'tree' : 'blob'
  return `${REPOSITORY}/${kind}/main/${resolved.replace(/\/$/, '')}${hash}`
}
