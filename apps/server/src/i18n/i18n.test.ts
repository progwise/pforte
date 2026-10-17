import { describe, expect, it } from 'vitest'
import { BUILT_IN, createI18n, parseAcceptLanguage } from './index.js'
import { en, type MessageKey } from './en.js'

const keys = Object.keys(en) as MessageKey[]
const placeholdersOf = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort()

describe('built-in languages', () => {
  it('come with English, German, French and Hungarian', () => {
    expect(Object.keys(BUILT_IN).sort()).toEqual(['de', 'en', 'fr', 'hu'])
  })

  it.each(['de', 'fr', 'hu'])('%s has every text, with the same values to fill in as English', (language) => {
    const catalog = BUILT_IN[language]!
    expect(Object.keys(catalog).sort()).toEqual([...keys].sort())
    for (const key of keys) {
      expect(placeholdersOf(catalog[key]), `${language}: ${key}`).toEqual(placeholdersOf(en[key]))
      expect(catalog[key].trim(), `${language}: ${key} is empty`).not.toBe('')
    }
  })

  it.each(['en', 'de', 'fr', 'hu'])('%s has no HTML in its texts, as they are escaped where they are shown', (language) => {
    for (const key of keys) expect(BUILT_IN[language]![key], `${language}: ${key}`).not.toMatch(/[<>]/)
  })

  it.each(['en', 'de', 'fr', 'hu'])('%s keeps every SMS text within 160 characters, before the link that follows the reset text', (language) => {
    const i18n = createI18n()
    for (const key of ['sms.login', 'sms.reset', 'sms.phone'] as const) {
      const text = i18n.text(language, key, { code: '123456', organisation: 'Example Industries', minutes: 10 })
      expect(text.length, `${language}: ${key}`).toBeLessThanOrEqual(160)
      expect(text.startsWith('123456') || language === 'hu', `${language}: ${key} starts with the code`).toBe(true)
    }
  })
})

describe('choosing a language', () => {
  const i18n = createI18n()

  it('takes the first candidate pforte speaks, ignoring case and region', () => {
    expect(i18n.pick('xx', 'FR')).toBe('fr')
    expect(i18n.pick('de-AT')).toBe('de')
    expect(i18n.pick(['zz', 'hu-HU', 'de'])).toBe('hu')
  })

  it('skips what is missing and falls back to the default', () => {
    expect(i18n.pick(undefined, '', ['xx'])).toBe('en')
    expect(i18n.pick()).toBe('en')
    expect(createI18n({ defaultLanguage: 'de' }).pick('xx')).toBe('de')
  })

  it('refuses a default language it has no texts for', () => {
    expect(() => createI18n({ defaultLanguage: 'nl' })).toThrow(/no texts/)
  })

  it('reads Accept-Language by preference, leaving out q=0 and the wildcard', () => {
    expect(parseAcceptLanguage('de-DE,de;q=0.9,en;q=0.8')).toEqual(['de-DE', 'de', 'en'])
    expect(parseAcceptLanguage('en;q=0.5, fr;q=0.9, *;q=0.1, hu;q=0')).toEqual(['fr', 'en'])
    expect(parseAcceptLanguage('en;q=oops')).toEqual([])
    expect(parseAcceptLanguage(undefined)).toEqual([])
  })
})

describe('texts', () => {
  it('fills in the values and leaves unknown ones visible', () => {
    const i18n = createI18n()
    expect(i18n.text('en', 'phone.wait', { seconds: 42 })).toBe('Please wait 42 seconds before asking for another code.')
    expect(i18n.text('de', 'phone.wait', { seconds: 42 })).toContain('42 Sekunden')
    expect(i18n.text('en', 'phone.wait')).toContain('{seconds}')
  })

  it('replaces a built-in text with the installation\'s own', () => {
    const i18n = createI18n({ overrides: { de: { 'login.submit': 'Los geht\'s' } } })
    expect(i18n.text('de', 'login.submit')).toBe("Los geht's")
    expect(i18n.text('de', 'login.title')).toBe('Anmelden')
    expect(i18n.text('en', 'login.submit')).toBe('Sign in')
  })

  it('adds a language, and shows English where it has no text yet', () => {
    const i18n = createI18n({ overrides: { nl: { 'login.title': 'Inloggen' } } })
    expect(i18n.languages).toContain('nl')
    expect(i18n.pick('nl-BE')).toBe('nl')
    expect(i18n.text('nl', 'login.title')).toBe('Inloggen')
    expect(i18n.text('nl', 'login.submit')).toBe('Sign in')
  })

  it('uses English for a language it does not know at all', () => {
    expect(createI18n().text('xx', 'login.title')).toBe('Sign in')
  })
})
