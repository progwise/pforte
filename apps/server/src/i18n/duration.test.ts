import { describe, expect, it } from 'vitest'
import { DURATION_VALUES, shortWaitValues, validity, waitValues, withWait } from './duration.js'
import { BUILT_IN, createI18n, type I18n, type Worded } from './index.js'

const i18n = createI18n()
const LANGUAGES = ['en', 'de', 'fr', 'hu']
/** A time in words, with the texts of one language. */
const worded = (language: string, value: Worded, from: I18n = i18n) => value((key, values) => from.text(language, key, values))

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
    expect(LANGUAGES.map((language) => worded(language, validity(milliseconds)))).toEqual([en, de, fr, hu])
  })

  it('names the whole time in a message that is written a moment after the link or the code was made', () => {
    expect(worded('en', validity(7 * DAY - 40))).toBe('7 days')
    expect(worded('en', validity(10 * MINUTE - 40))).toBe('10 minutes')
    expect(worded('en', validity(HOUR - 40))).toBe('1 hour')
    // Half a minute is what a message may be late by. Beyond it the time is rounded down.
    expect(worded('en', validity(7 * DAY - 29_000))).toBe('7 days')
    expect(worded('en', validity(7 * DAY - 31_000))).toBe('6 days')
  })

  it('never promises more hours or days than there are, and never less than a minute', () => {
    expect(worded('en', validity(46 * HOUR + 30 * MINUTE))).toBe('46 hours')
    expect(worded('en', validity(47 * HOUR + 30 * MINUTE))).toBe('47 hours')
    expect(worded('en', validity(48 * HOUR - MINUTE))).toBe('47 hours')
    expect(worded('en', validity(60 * HOUR))).toBe('2 days')
    expect(worded('en', validity(71 * HOUR + 30 * MINUTE))).toBe('2 days')
    expect(worded('en', validity(90 * MINUTE))).toBe('1 hour')
    expect(worded('en', validity(5_000))).toBe('1 minute')
  })
})

describe('how long to wait, in words', () => {
  it.each([
    [1, 1, '1 minute', '1 Minute', '1 minute', '1 perc'],
    [60, 1, '1 minute', '1 Minute', '1 minute', '1 perc'],
    [61, 2, '2 minutes', '2 Minuten', '2 minutes', '2 perc'],
    [3600, 60, '60 minutes', '60 Minuten', '60 minutes', '60 perc'],
  ])('%d seconds', (seconds, minutes, en, de, fr, hu) => {
    expect(waitValues(seconds).minutes).toBe(minutes)
    expect(LANGUAGES.map((language) => worded(language, waitValues(seconds).wait))).toEqual([en, de, fr, hu])
  })

  it('reads as a sentence with one minute and with several', () => {
    const sentence = (language: string, seconds: number) => i18n.text(language, 'limit.text', waitValues(seconds))
    expect(sentence('en', 30)).toContain('Please try again in 1 minute.')
    expect(sentence('en', 300)).toContain('Please try again in 5 minutes.')
    expect(sentence('de', 30)).toContain('in 1 Minute erneut.')
    expect(sentence('fr', 30)).toContain('dans 1 minute.')
    expect(sentence('hu', 300)).toContain('5 perc múlva.')
  })
})

describe('how long to wait where it can be seconds, in words', () => {
  it.each([
    [1, '1 second', '1 Sekunde', '1 seconde', '1 másodperc'],
    [2, '2 seconds', '2 Sekunden', '2 secondes', '2 másodperc'],
    [59, '59 seconds', '59 Sekunden', '59 secondes', '59 másodperc'],
    [60, '1 minute', '1 Minute', '1 minute', '1 perc'],
    [61, '2 minutes', '2 Minuten', '2 minutes', '2 perc'],
    [3540, '59 minutes', '59 Minuten', '59 minutes', '59 perc'],
  ])('%d seconds', (seconds, en, de, fr, hu) => {
    expect(shortWaitValues(seconds).seconds).toBe(seconds)
    expect(LANGUAGES.map((language) => worded(language, shortWaitValues(seconds).wait))).toEqual([en, de, fr, hu])
  })

  it('is never less than a second', () => {
    expect(worded('en', shortWaitValues(0).wait)).toBe('1 second')
    expect(worded('en', shortWaitValues(0.2).wait)).toBe('1 second')
  })

  it('reads as a sentence with one second, with several, and with minutes', () => {
    const cooldown = (language: string, seconds: number) => i18n.text(language, 'code.cooldown', shortWaitValues(seconds))
    expect(cooldown('en', 1)).toBe('A code was sent a moment ago. You can ask for a new one in 1 second.')
    expect(cooldown('en', 45)).toContain('in 45 seconds.')
    expect(cooldown('de', 1)).toContain('in 1 Sekunde anfordern.')
    expect(cooldown('fr', 1)).toContain('dans 1 seconde.')
    expect(cooldown('hu', 1)).toContain('1 másodperc múlva kérhet.')

    // The wait for another code for a phone number can also be the rest of an hour.
    const phone = (language: string, seconds: number) => i18n.text(language, 'phone.wait', shortWaitValues(seconds))
    expect(phone('en', 1)).toBe('Please wait 1 second before asking for another code.')
    expect(phone('en', 3540)).toBe('Please wait 59 minutes before asking for another code.')
    expect(phone('de', 45)).toContain('warten Sie 45 Sekunden,')
    expect(phone('fr', 1)).toContain('patienter 1 seconde avant')
    expect(phone('hu', 45)).toBe('Újabb kódot 45 másodperc múlva kérhet.')
  })
})

describe('a wait that came to the page in a message, as a number of seconds', () => {
  const shown = (key: Parameters<typeof withWait>[0], values?: Parameters<typeof withWait>[1], language = 'en') => i18n.text(language, key, withWait(key, values))

  it('gets its words on the page that shows it: seconds and minutes where the text can be short, minutes else', () => {
    expect(shown('phone.wait', { seconds: 1 })).toBe('Please wait 1 second before asking for another code.')
    expect(shown('phone.wait', { seconds: 3540 })).toBe('Please wait 59 minutes before asking for another code.')
    expect(shown('phone.wait', { seconds: 45 }, 'de')).toContain('warten Sie 45 Sekunden,')
    expect(shown('account.password.wait', { seconds: 45 })).toContain('in 1 minute')
    expect(shown('account.password.wait', { seconds: 300 }, 'de')).toContain('in 5 Minuten')
  })

  it('still fills a text of an installation that writes the bare number', () => {
    const own = createI18n({ overrides: { de: { 'phone.wait': 'Noch {seconds} Sek.', 'account.password.wait': 'Noch {minutes} Min.' } } })
    expect(own.text('de', 'phone.wait', withWait('phone.wait', { seconds: 45 }))).toBe('Noch 45 Sek.')
    expect(own.text('de', 'account.password.wait', withWait('account.password.wait', { seconds: 300 }))).toBe('Noch 5 Min.')
  })

  it('leaves every other text and a message without a wait as they are', () => {
    expect(withWait('account.password.unavailable')).toEqual({})
    expect(withWait('phone.wait')).toEqual({})
    expect(withWait('manage.import.doneTitle', { seconds: 4 })).toEqual({ seconds: 4 })
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
    expect(worded('nl', validity(7 * DAY), own)).toBe('7 dagen')
    expect(worded('nl', validity(HOUR), own)).toBe('1 hour')
    expect(worded('de', validity(7 * DAY), own)).toBe('7 Tage lang')
  })

  describe('in a language that has only some of the texts', () => {
    const sentence = 'Code per e-mail naar {to}. Hij is {validity} geldig.'
    const words = { 'duration.for.minute.other': '{count} minuten' } as const
    const sent = (texts: Record<string, string>, language = 'nl') =>
      createI18n({ overrides: { nl: texts } }).text(language, 'code.sentEmail', { to: 'a@b.c', validity: validity(10 * MINUTE) })

    it('words the time in the language of the sentence: an English sentence gets English words', () => {
      expect(sent(words)).toBe('We sent a 6-digit code by e-mail to a@b.c. It is valid for 10 minutes.')
      expect(createI18n({ overrides: { nl: words } }).text('nl', 'limit.text', waitValues(300))).toContain('Please try again in 5 minutes.')
    })

    it('uses the language\'s own words in its own sentence, and English ones while it has none', () => {
      expect(sent({ ...words, 'code.sentEmail': sentence })).toBe('Code per e-mail naar a@b.c. Hij is 10 minuten geldig.')
      expect(sent({ 'code.sentEmail': sentence })).toBe('Code per e-mail naar a@b.c. Hij is 10 minutes geldig.')
    })

    it('looks for the words of a region where the sentence is, then in its language', () => {
      const regional = createI18n({ overrides: { 'fr-CH': { 'duration.for.minute.other': '{count} min' } } })
      const text = (language: string) => regional.text(language, 'code.sentEmail', { to: 'a@b.c', validity: validity(10 * MINUTE) })
      // The sentence is the French one, so the words are French, not those of the region that has no sentence.
      expect(text('fr-CH')).toContain('Il est valable 10 minutes.')
      expect(text('fr')).toContain('Il est valable 10 minutes.')
    })
  })
})
