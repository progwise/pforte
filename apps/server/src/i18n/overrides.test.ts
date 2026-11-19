import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadLocaleOverrides } from './overrides.js'

const folderWith = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'pforte-branding-'))
  mkdirSync(join(dir, 'locales'))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, 'locales', name), content)
  return dir
}

describe('locale overrides', () => {
  it('has nothing to read without a locales folder', () => {
    expect(loadLocaleOverrides(mkdtempSync(join(tmpdir(), 'pforte-branding-')))).toEqual({ overrides: {}, warnings: [] })
  })

  it('reads texts for built-in and new languages', () => {
    const { overrides, warnings } = loadLocaleOverrides(
      folderWith({
        'de.json': JSON.stringify({ 'login.submit': 'Weiter', 'code.sentSms': 'SMS an {to} gesendet.' }),
        'nl.json': JSON.stringify({ 'login.title': 'Inloggen' }),
        'notes.txt': 'ignored',
      }),
    )
    expect(overrides).toEqual({ de: { 'login.submit': 'Weiter', 'code.sentSms': 'SMS an {to} gesendet.' }, nl: { 'login.title': 'Inloggen' } })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/new language "nl" lacks \d+ of \d+ texts/)
  })

  it('does not warn about a built-in language that is only partly overridden', () => {
    expect(loadLocaleOverrides(folderWith({ 'fr.json': '{"login.submit":"Entrer"}' })).warnings).toEqual([])
  })

  it('still reads a text that states a time as it did before the time came in words, or writes it out itself', () => {
    const texts = {
      'mail.activation.text': 'Guten Tag {firstName}, Ihr Link für {organisation}: {url}. Er gilt {hours} Stunden.',
      'mail.activationFor.text': 'Guten Tag {firstName}, Ihr Link für {application} bei {organisation}: {url}. Er gilt eine Woche.',
      'limit.text': 'Zu viele Versuche. Weiter in {minutes} Min.',
      'code.tooMany': 'Zu viele Codes. Weiter in {wait}.',
      'code.cooldown': 'Gerade gesendet. Neuer Code in {seconds} Sek.',
      'phone.wait': 'Bitte kurz warten.',
      'reset.sent': 'Wir haben eine Nachricht gesendet. Ein Code gilt 10 Minuten.',
      'duration.for.day.other': '{count} Tage lang',
    }
    expect(loadLocaleOverrides(folderWith({ 'de.json': JSON.stringify(texts) })).overrides).toEqual({ de: texts })
  })

  it.each([
    ['de.json', '{"mail.activation.text":"Guten Tag {firstName}, Ihr Link für {organisation} gilt {validity}."}', /must contain \{url\}/],
    ['de.json', '{"limit.text":"Weiter in {hours} Stunden."}', /uses \{hours\}, which this text does not have/],
    ['de.json', '{"reset.sent":"Ein Code gilt {minutes} Minuten."}', /uses \{minutes\}, which this text does not have/],
    ['de.json', '{"code.cooldown":"Neuer Code in {minutes} Minuten."}', /uses \{minutes\}, which this text does not have/],
    ['de.json', '{"duration.for.day.other":"Tage"}', /must contain \{count\}/],
    ['Deutsch.json', '{}', /must be a language code/],
    ['de.json', '{oops', /not valid JSON/],
    ['de.json', '["a"]', /must be a JSON object/],
    ['de.json', '{"login.submitt":"x"}', /"login.submitt" is not a text of pforte/],
    ['de.json', '{"login.submit":5}', /must be a non-empty text/],
    ['de.json', '{"login.submit":"  "}', /must be a non-empty text/],
    ['de.json', '{"mail.loginCode.text":"Ihr Code ist da."}', /must contain .*\{code\}/],
    ['de.json', '{"login.submit":"Weiter {name}"}', /uses \{name\}, which this text does not have/],
  ])('refuses %s with %s, naming the file', (name, content, message) => {
    expect(() => loadLocaleOverrides(folderWith({ [name]: content }))).toThrow(message)
    expect(() => loadLocaleOverrides(folderWith({ [name]: content }))).toThrow(name)
  })
})
