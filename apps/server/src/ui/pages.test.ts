import { describe, expect, it } from 'vitest'
import { createUi } from './index.js'

describe('pages', () => {
  const { pages } = createUi()

  it('are written in the language asked for, and say so in the document', () => {
    const french = pages.for('fr').login({ uid: 'u1' })
    expect(french).toContain('<html lang="fr">')
    expect(french).toContain('Mot de passe')
    expect(french).toContain('Mot de passe oublié ?')
    expect(pages.for('hu').login({ uid: 'u1' })).toContain('Bejelentkezés')
    expect(pages.for('de').login({ uid: 'u1' })).toContain('<html lang="de">')
  })

  it('fall back to the default language for one they do not have', () => {
    expect(pages.for('xx').login({ uid: 'u1' })).toContain('<html lang="en">')
  })

  it('escape everything that comes from outside, in every language', () => {
    for (const language of ['en', 'de', 'fr', 'hu']) {
      const view = pages.for(language)
      const html = view.login({ uid: 'u"1', clientName: '<script>x</script>', email: '"><img src=x>', error: '<b>' })
      expect(html).not.toContain('<script>')
      // The page has an image of its own, the logo; the one from outside must not become a second.
      expect(html).not.toContain('<img src=x')
      expect(html.match(/<img/g)).toHaveLength(1)
      expect(html).not.toContain('<b>')
      expect(view.notice('<i>', '<u>')).not.toMatch(/<[iu]>/)
      expect(view.code({ uid: 'u', channel: 'email', sentTo: '<a***@x>' })).not.toContain('<a***')
    }
  })

  it('hand the language on to the pages that cannot know it otherwise', () => {
    const forgot = pages.for('fr').forgotPassword({})
    expect(forgot).toContain('name="lang" value="fr"')
    expect(pages.for('hu').resetCode({ email: 'a@b.c' })).toContain('lang=hu')
    expect(pages.for('de').login({ uid: 'u' })).toContain('href="/reset?lang=de"')
  })

  it('puts the link for a forgotten password under the button of the password, before the other ways on', () => {
    const page = pages.for('en').login({ uid: 'u', passkey: { attributes: 'data-passkey="get" hidden', script: '' } })
    const order = ['>Sign in</button>', '<p class="aside"><a href="/reset?lang=en">Forgot your password?</a></p>', 'data-passkey="get"', '>Cancel</button>'].map((part) => page.indexOf(part))

    expect(order.every((position) => position >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('leave "remember this device" unticked unless the installation wants it ticked', () => {
    const code = { uid: 'u', channel: 'email' as const, sentTo: 'a***@b.c' }
    expect(pages.for('en').code(code)).not.toMatch(/name="remember" checked/)
    expect(pages.for('en').code(code)).toContain('name="remember">')
    expect(createUi({ rememberDeviceDefault: true }).pages.for('en').code(code)).toContain('name="remember" checked>')
  })

  it('offer the same box on the activation page, and keep it as the person left it when the page comes again', () => {
    const ticked = createUi({ rememberDeviceDefault: true }).pages.for('en')
    const link = { token: 't', email: 'ada@example.com' }
    expect(pages.for('en').activation(link)).toContain('name="remember"> Remember this device for 90 days')
    expect(ticked.activation(link)).toContain('name="remember" checked>')
    expect(pages.for('en').activation({ ...link, error: 'x', remember: true })).toContain('name="remember" checked>')
    expect(ticked.activation({ ...link, error: 'x', remember: false })).toContain('name="remember">')
  })

  describe('where a person chooses a password', () => {
    const USERNAME = '<input id="email" name="email" type="email" autocomplete="username" required readonly value="ada@example.com">'
    /** The fields of the page that a person sees, in their order: what a password manager goes by. */
    const visibleFields = (html: string) => [...html.matchAll(/<input [^>]*>/g)].map(([field]) => field).filter((field) => !/type="(hidden|checkbox)"/.test(field))
    const autocompleteOf = (html: string) => visibleFields(html).map((field) => /autocomplete="([^"]*)"/.exec(field)?.[1])

    it('shows the address as the user name directly above the new password, after a reset below the code', () => {
      const reset = pages.for('en').resetCode({ email: 'ada@example.com' })
      expect(autocompleteOf(reset)).toEqual(['one-time-code', 'username', 'new-password', 'new-password'])
      expect(reset).toContain(`<label for="email">E-mail</label>\n${USERNAME}`)
      // The address is posted by the field a person sees, and by no second one.
      expect(reset.match(/name="email"/g)).toHaveLength(1)

      const activation = pages.for('en').activation({ token: 't', email: 'ada@example.com' })
      expect(autocompleteOf(activation)).toEqual(['username', 'new-password', 'new-password'])
      expect(activation).toContain(`<label for="email">E-mail</label>\n${USERNAME}`)
    })

    it('asks for the address where the page was opened without one', () => {
      const reset = pages.for('en').resetCode({ email: '' })
      expect(reset).toContain('<input id="email" name="email" type="email" autocomplete="username" required value="">')
      expect(reset).not.toContain(' readonly ')
    })

    it('escapes the address', () => {
      for (const page of [pages.for('en').resetCode({ email: '"><img src=x>' }), pages.for('en').activation({ token: 't', email: '"><img src=x>' })]) {
        expect(page).not.toContain('<img src=x')
        expect(page).toContain('value="&quot;&gt;&lt;img src=x&gt;"')
      }
    })
  })

  describe('of an area with sections', () => {
    const nav = [
      { href: '/account', label: 'Overview' },
      { href: '/account/devices', label: 'Devices <2>', current: true },
    ]
    const area = (options: Partial<Parameters<ReturnType<typeof pages.for>['manage']>[0]> = {}) =>
      pages.for('en').manage({ title: 'Devices', nav, sectionsLabel: 'Sections', content: '', person: { signedInAs: 'Signed in as <Ada>', signOutLabel: 'Sign out' }, ...options })
    const LINKS = '<a href="/account">Overview</a>\n<a href="/account/devices" aria-current="page">Devices &lt;2&gt;</a>'

    it('have the sections as a row, and for a phone as a menu that names the current one and needs no script', () => {
      const page = area()
      expect(page).toContain(`<nav class="sections" aria-label="Sections">\n${LINKS}\n</nav>`)
      expect(page).toContain(`<details class="menu">\n<summary><span>Devices &lt;2&gt;</span></summary>\n<nav aria-label="Sections">\n${LINKS}\n<p>Signed in as &lt;Ada&gt;</p>\n</nav>\n</details>`)
      // Closed when the page comes, so it is one line; the stylesheet shows it on a narrow screen only.
      expect(page).not.toContain('<details class="menu" open')
      expect(page).toMatch(/details\.menu \{ display: none; \}\n@media \(max-width: 40rem\) \{[^@]*nav\.sections \{ display: none; \}[^@]*details\.menu \{ display: block;/)
      expect(page).not.toContain('<script')
    })

    it('name the menu by what it holds where no section is the current one, and leave the person out where there is none', () => {
      const page = area({ nav: nav.map(({ href, label }) => ({ href, label })), person: undefined })
      expect(page).toContain('<summary><span>Sections</span></summary>')
      expect(page).not.toContain('Signed in as')
    })
  })

  it('show where the code went in the right words', () => {
    expect(pages.for('en').code({ uid: 'u', channel: 'sms', sentTo: '+49•78' })).toContain('by SMS to +49•78')
    expect(pages.for('de').code({ uid: 'u', channel: 'email', sentTo: 'a***@b.c' })).toContain('per E-Mail an a***@b.c')
    expect(pages.for('fr').code({ uid: 'u', channel: 'sms', sentTo: '+49•78' })).toContain('par SMS')
  })

  it('say how long the code is valid, in every language', () => {
    const sentence = (language: string, channel: 'email' | 'sms') => pages.for(language).code({ uid: 'u', channel, sentTo: 'x' })
    expect(sentence('en', 'email')).toContain('It is valid for 10 minutes.')
    expect(sentence('en', 'sms')).toContain('It is valid for 10 minutes.')
    expect(sentence('de', 'email')).toContain('Er ist 10 Minuten gültig.')
    expect(sentence('fr', 'sms')).toContain('Il est valable 10 minutes.')
    expect(sentence('hu', 'email')).toContain('A kód 10 percig érvényes.')
  })
})
