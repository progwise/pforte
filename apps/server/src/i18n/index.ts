import { adminDe } from './admin-de.js'
import { type AdminKey, adminEn } from './admin-en.js'
import { de } from './de.js'
import { type Catalog, en, type MessageKey as CoreKey } from './en.js'
import { fr } from './fr.js'
import { hu } from './hu.js'

export type { Catalog } from './en.js'
export type { AdminKey } from './admin-en.js'

/** Every text there is: those of the sign-in pages and messages, and those of the administration UI. */
export type MessageKey = CoreKey | AdminKey

export type Values = Record<string, string | number>

/** A text in one language: `view.t` of a page, or `i18n.text` with the language filled in. */
export type Translate = (key: MessageKey, values?: TextValues) => string

/**
 * A value that is made of texts itself, such as a time in words (see `duration.ts`). It gets the texts of the language
 * the sentence around it comes from, so a sentence that falls back to English is not filled with words of another language.
 */
export type Worded = (t: Translate) => string

/** What a text is filled with. Only plain `Values` can travel, in a cookie for instance; a `Worded` is worded where the text is made. */
export type TextValues = Record<string, string | number | Worded>

/** The languages that come with pforte. More are added by files in the branding folder. */
export const BUILT_IN: Record<string, Catalog> = { en, de, fr, hu }

/** The texts of the administration UI: English and German; other languages show the English ones. */
const ADMIN: Record<string, Partial<Record<AdminKey, string>>> = { en: adminEn, de: adminDe }

/** Everything in English: the fallback of every other language, and the list of texts that exist. */
export const ALL_ENGLISH: Record<MessageKey, string> = { ...en, ...adminEn }

/** `fr-CH` → `fr`; a language tag is case-insensitive. */
const baseOf = (tag: string) => tag.toLowerCase().split('-')[0]!

/** The languages of an `Accept-Language` header, most preferred first. Quality values order them; `q=0` means "not this". */
export const parseAcceptLanguage = (header: string | undefined) =>
  (header ?? '')
    .split(',')
    .map((part, index) => {
      const [tag = '', ...parameters] = part.trim().split(';')
      const quality = Number(parameters.find((parameter) => parameter.trim().startsWith('q='))?.trim().slice(2) ?? 1)
      return { tag: tag.trim(), quality: Number.isNaN(quality) ? 0 : quality, index }
    })
    .filter(({ tag, quality }) => tag && tag !== '*' && quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
    .map(({ tag }) => tag)

export interface I18n {
  /** Every language that has texts, built in or added. */
  readonly languages: string[]
  readonly defaultLanguage: string
  /** The first of the candidates that pforte speaks (`fr-CH` counts as `fr`), or the default language. */
  pick(...candidates: (string | string[] | undefined)[]): string
  /** A text in a language, with `{name}` filled in. Falls back to English, so a text is never missing. */
  text(language: string, key: MessageKey, values?: TextValues): string
}

export interface I18nOptions {
  /** Texts for additional languages, or replacements for built-in ones. A text left out falls back to the built-in one. */
  overrides?: Record<string, Partial<Record<MessageKey, string>>>
  defaultLanguage?: string
}

const fill = (template: string, values: TextValues, t: Translate) =>
  template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    if (!Object.hasOwn(values, name)) return placeholder
    const value = values[name]!
    return typeof value === 'function' ? value(t) : String(value)
  })

export const createI18n = ({ overrides = {}, defaultLanguage = 'en' }: I18nOptions = {}): I18n => {
  const catalogs = new Map<string, Partial<Record<MessageKey, string>>>()
  for (const language of new Set([...Object.keys(BUILT_IN), ...Object.keys(overrides)])) {
    catalogs.set(language.toLowerCase(), { ...BUILT_IN[language], ...ADMIN[language], ...overrides[language] })
  }
  if (!catalogs.has(defaultLanguage.toLowerCase())) throw new Error(`The default language "${defaultLanguage}" has no texts`)

  /** A text of the language that has it: the one asked for, its base (`fr-CH` → `fr`), or built-in English, for which `undefined` stands. */
  const textIn = (language: string | undefined, key: MessageKey, values: TextValues): string => {
    const source = language === undefined ? undefined : [language.toLowerCase(), baseOf(language)].find((tag) => catalogs.get(tag)?.[key] !== undefined)
    const template = source === undefined ? ALL_ENGLISH[key] : catalogs.get(source)![key]!
    return fill(template, values, (nestedKey, nestedValues = {}) => textIn(source, nestedKey, nestedValues))
  }

  return {
    languages: [...catalogs.keys()],
    defaultLanguage: defaultLanguage.toLowerCase(),
    pick(...candidates) {
      for (const tag of candidates.flat()) {
        if (!tag) continue
        const wanted = tag.toLowerCase()
        const found = catalogs.has(wanted) ? wanted : catalogs.has(baseOf(wanted)) ? baseOf(wanted) : undefined
        if (found) return found
      }
      return defaultLanguage.toLowerCase()
    },
    text: (language, key, values = {}) => textIn(language, key, values),
  }
}
