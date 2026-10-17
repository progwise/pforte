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

  it.each([
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
