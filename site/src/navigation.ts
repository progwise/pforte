/** The pages of the site: which file each one is made from, and how they are grouped in the menu. */
export interface NavigationEntry {
  /** The address below the site: `security` is `/security/`; empty is the front page. */
  slug: string
  /** The file in the repository. */
  source: string
  /** The name in the menu, where the title of the document is not what it should say there. */
  menu?: string
}

export interface NavigationGroup {
  title: string
  pages: NavigationEntry[]
}

export const navigation: NavigationGroup[] = [
  {
    title: 'Start',
    pages: [
      { slug: '', source: 'docs/index.md', menu: 'What is pforte' },
      { slug: 'quick-start', source: 'docs/quick-start.md' },
    ],
  },
  {
    title: 'Integrate',
    pages: [{ slug: 'integrating-a-client', source: 'docs/integrating-a-client.md', menu: 'Integrating an application' }],
  },
  {
    title: 'Operate',
    pages: [
      { slug: 'production', source: 'examples/production/README.md', menu: 'Production with Docker Compose' },
      { slug: 'configuration', source: 'docs/configuration.md' },
      { slug: 'administration', source: 'docs/administration.md', menu: 'The administration' },
      { slug: 'import', source: 'docs/import.md', menu: 'Importing users' },
      { slug: 'branding-and-languages', source: 'docs/branding-and-languages.md', menu: 'Branding and languages' },
      { slug: 'sms', source: 'docs/sms.md', menu: 'Codes by SMS' },
      { slug: 'changelog', source: 'CHANGELOG.md' },
      { slug: 'releasing', source: 'docs/releasing.md' },
    ],
  },
  {
    title: 'Security',
    pages: [
      { slug: 'security', source: 'docs/security.md', menu: 'Security measures' },
      { slug: 'security-policy', source: 'SECURITY.md', menu: 'Reporting a vulnerability' },
      { slug: 'threat-model', source: 'docs/threat-model.md' },
      { slug: 'rate-limiting', source: 'docs/rate-limiting.md', menu: 'Rate limits' },
      { slug: 'audit-log', source: 'docs/audit-log.md', menu: 'The audit log' },
      { slug: 'conformance', source: 'docs/conformance.md', menu: 'OpenID conformance' },
    ],
  },
]

/** Files of `docs/` that are not part of the site, each with the reason. */
export const notPublished: Record<string, string> = {}

export const urlOf = (slug: string) => (slug === '' ? '/' : `/${slug}/`)
