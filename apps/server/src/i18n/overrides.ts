import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ALL_ENGLISH, BUILT_IN, type MessageKey } from './index.js'

const placeholdersOf = (text: string) => new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!))

export interface LocaleOverrides {
  overrides: Record<string, Partial<Record<MessageKey, string>>>
  /** Things worth telling the administrator at startup, e.g. a new language that lacks some texts. */
  warnings: string[]
}

/**
 * Reads `<dir>/locales/<language>.json`: texts that replace built-in ones, or a whole new language.
 * Mistakes stop the start with a message naming the file and the text, so a typo in a key or a lost
 * `{code}` is found at once and not by a user.
 */
export const loadLocaleOverrides = (dir: string, read = readFileSync): LocaleOverrides => {
  const folder = join(dir, 'locales')
  const result: LocaleOverrides = { overrides: {}, warnings: [] }
  if (!existsSync(folder)) return result

  for (const file of readdirSync(folder).sort()) {
    if (!file.endsWith('.json')) continue
    const language = file.slice(0, -'.json'.length)
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language)) {
      throw new Error(`locales/${file}: the file name must be a language code such as de.json or pt-BR.json`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(read(join(folder, file), 'utf8'))
    } catch (error) {
      throw new Error(`locales/${file}: not valid JSON (${(error as Error).message})`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`locales/${file}: must be a JSON object of text keys and texts`)
    }

    const texts: Partial<Record<MessageKey, string>> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in ALL_ENGLISH)) throw new Error(`locales/${file}: "${key}" is not a text of pforte. See docs/branding-and-languages.md for the list`)
      if (typeof value !== 'string' || value.trim() === '') throw new Error(`locales/${file}: "${key}" must be a non-empty text`)
      const wanted = placeholdersOf(ALL_ENGLISH[key as MessageKey])
      const given = placeholdersOf(value)
      const unknown = [...given].filter((name) => !wanted.has(name))
      const missing = [...wanted].filter((name) => !given.has(name))
      if (unknown.length > 0) throw new Error(`locales/${file}: "${key}" uses ${unknown.map((name) => `{${name}}`).join(', ')}, which this text does not have`)
      if (missing.length > 0) throw new Error(`locales/${file}: "${key}" must contain ${missing.map((name) => `{${name}}`).join(', ')}`)
      texts[key as MessageKey] = value
    }
    result.overrides[language] = texts

    if (!(language in BUILT_IN)) {
      const absent = (Object.keys(ALL_ENGLISH) as MessageKey[]).filter((key) => !(key in texts))
      if (absent.length > 0) {
        result.warnings.push(`The new language "${language}" lacks ${absent.length} of ${Object.keys(ALL_ENGLISH).length} texts; those appear in English.`)
      }
    }
  }
  return result
}
