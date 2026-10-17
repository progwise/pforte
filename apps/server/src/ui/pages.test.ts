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
      expect(html).not.toContain('<img')
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

  it('leave "remember this device" unticked unless the installation wants it ticked', () => {
    const code = { uid: 'u', channel: 'email' as const, sentTo: 'a***@b.c' }
    expect(pages.for('en').code(code)).not.toMatch(/name="remember" checked/)
    expect(pages.for('en').code(code)).toContain('name="remember">')
    expect(createUi({ rememberDeviceDefault: true }).pages.for('en').code(code)).toContain('name="remember" checked>')
  })

  it('show where the code went in the right words', () => {
    expect(pages.for('en').code({ uid: 'u', channel: 'sms', sentTo: '+49•78' })).toContain('by SMS to +49•78')
    expect(pages.for('de').code({ uid: 'u', channel: 'email', sentTo: 'a***@b.c' })).toContain('per E-Mail an a***@b.c')
    expect(pages.for('fr').code({ uid: 'u', channel: 'sms', sentTo: '+49•78' })).toContain('par SMS')
  })
})
