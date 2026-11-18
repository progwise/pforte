import type { MessageKey, Values } from './index.js'

/** A text in the language of the reader: `view.t` of a page, or `i18n.text` with the language filled in. */
type Translate = (key: MessageKey, values?: Values) => string

/** The four built-in languages say "1 minute" and "2 minutes"; a language with more forms than these two has its own texts. */
const form = (count: number) => (count === 1 ? 'one' : 'other')

/**
 * How long something stays valid, as a person says it: minutes below an hour, hours below two days, whole days
 * from there on ("10 minutes", "1 hour", "7 days"). In the form the sentence "valid for …" takes: "7 Tage", "7 napig".
 */
export const validity = (t: Translate, milliseconds: number) => {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000))
  if (minutes < 60) return t(`duration.for.minute.${form(minutes)}`, { count: minutes })
  const hours = Math.round(milliseconds / 3_600_000)
  if (hours < 48) return t(`duration.for.hour.${form(hours)}`, { count: hours })
  // Rounded down: a link of two and a half days is valid for two days, not for three.
  const days = Math.floor(hours / 24)
  return t(`duration.for.day.${form(days)}`, { count: days })
}

/**
 * What a text gets that says how long to wait: `wait` in words, rounded up to whole minutes, in the form the sentence
 * "again in …" takes ("1 minute", "5 Minuten", "5 perc"); and `minutes`, the bare number such a text had before 0.3.2.
 */
export const waitValues = (t: Translate, seconds: number) => {
  const minutes = Math.max(1, Math.ceil(seconds / 60))
  return { wait: t(`duration.in.minute.${form(minutes)}`, { count: minutes }), minutes }
}

/**
 * The texts that state a time. They get it in words (`worded`). A text replaced through a `locales` folder may leave
 * that value out and write the time itself, and may use the bare number the text had before 0.3.2 (`number`), so a
 * folder written for an earlier version still loads and reads as it did.
 */
export const DURATION_VALUES: Partial<Record<MessageKey, { worded: string; number?: string }>> = {
  'code.sentEmail': { worded: 'validity' },
  'code.sentSms': { worded: 'validity' },
  'reset.sent': { worded: 'validity' },
  'mail.activation.text': { worded: 'validity', number: 'hours' },
  'mail.activationFor.text': { worded: 'validity', number: 'hours' },
  'code.tooMany': { worded: 'wait', number: 'minutes' },
  'limit.text': { worded: 'wait', number: 'minutes' },
  'account.password.wait': { worded: 'wait', number: 'minutes' },
}
