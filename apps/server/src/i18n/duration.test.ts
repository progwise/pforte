import { describe, expect, it } from 'vitest'
import { DURATION_VALUES, validity, waitValues } from './duration.js'
import { BUILT_IN, createI18n, type MessageKey, type Values } from './index.js'

const i18n = createI18n()
const inLanguage = (language: string) => (key: MessageKey, values?: Values) => i18n.text(language, key, values)

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('how long something is valid, in words', () => {
  it.each([
    [10 * MINUTE, '10 minutes', '10 Minuten', '10 minutes', '10 percig'],
    [MINUTE, '1 minute', '1 Minute', '1 minute', '1 percig'],
    [HOUR, '1 hour', '1 Stunde', '1 heure', '1 óráig'],
    [24 * HOUR, '24 hours', '24 Stunden', '24 heures', '24 óráig'],
    [47 * HOUR, '47 hours', '47 Stunden', '47 heures', '47 óráig'],
    [48 * HOUR, '2 days', '2 Tage', '2 jours', '2 napig'],
    [7 * DAY, '7 days', '7 Tage', '7 jours', '7 napig'],
  ])('%d ms', (milliseconds, en, de, fr, hu) => {
    expect(['en', 'de', 'fr', 'hu'].map((language) => validity(inLanguage(language), milliseconds))).toEqual([en, de, fr, hu])
  })

  it('names the time a message is written a moment after the link was made', () => {
    expect(validity(inLanguage('en'), 7 * DAY - 40)).toBe('7 days')
    expect(validity(inLanguage('en'), 10 * MINUTE - 40)).toBe('10 minutes')
    expect(validity(inLanguage('en'), HOUR - 40)).toBe('1 hour')
  })

  it('never promises more whole days than there are, and never less than a minute', () => {
    expect(validity(inLanguage('en'), 60 * HOUR)).toBe('2 days')
    expect(validity(inLanguage('en'), 71 * HOUR)).toBe('2 days')
    expect(validity(inLanguage('en'), 5_000)).toBe('1 minute')
  })
})

describe('how long to wait, in words', () => {
  it.each([
    [1, 1, '1 minute', '1 Minute', '1 minute', '1 perc'],
    [60, 1, '1 minute', '1 Minute', '1 minute', '1 perc'],
    [61, 2, '2 minutes', '2 Minuten', '2 minutes', '2 perc'],
    [3600, 60, '60 minutes', '60 Minuten', '60 minutes', '60 perc'],
  ])('%d seconds', (seconds, minutes, en, de, fr, hu) => {
    expect(['en', 'de', 'fr', 'hu'].map((language) => waitValues(inLanguage(language), seconds))).toEqual(
      [en, de, fr, hu].map((wait) => ({ wait, minutes })),
    )
  })

  it('reads as a sentence with one minute and with several', () => {
    const sentence = (language: string, seconds: number) => i18n.text(language, 'limit.text', waitValues(inLanguage(language), seconds))
    expect(sentence('en', 30)).toContain('Please try again in 1 minute.')
    expect(sentence('en', 300)).toContain('Please try again in 5 minutes.')
    expect(sentence('de', 30)).toContain('in 1 Minute erneut.')
    expect(sentence('fr', 30)).toContain('dans 1 minute.')
    expect(sentence('hu', 300)).toContain('5 perc múlva.')
  })
})

describe('the texts that state a time', () => {
  it.each(Object.entries(DURATION_VALUES))('%s uses the time in words in every language, and not the bare number', (key, { worded, number }) => {
    for (const catalog of Object.values(BUILT_IN) as Record<string, string>[]) {
      const text = catalog[key]
      expect(text).toContain(`{${worded}}`)
      if (number) expect(text).not.toContain(`{${number}}`)
    }
  })

  it('uses a language\'s own words for the time, and English ones where an added language has none', () => {
    const own = createI18n({ overrides: { nl: { 'duration.for.day.other': '{count} dagen' }, de: { 'duration.for.day.other': '{count} Tage lang' } } })
    const t = (language: string) => (key: MessageKey, values?: Values) => own.text(language, key, values)
    expect(validity(t('nl'), 7 * DAY)).toBe('7 dagen')
    expect(validity(t('nl'), HOUR)).toBe('1 hour')
    expect(validity(t('de'), 7 * DAY)).toBe('7 Tage lang')
  })
})
