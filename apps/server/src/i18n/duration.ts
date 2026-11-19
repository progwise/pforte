import type { MessageKey, TextValues, Values, Worded } from './index.js'

/** The four built-in languages say "1 minute" and "2 minutes"; a language with more forms than these two has its own texts. */
const form = (count: number) => (count === 1 ? 'one' : 'other')

/**
 * How long something stays valid, as a person says it: minutes below an hour, hours below two days, whole days
 * from there on ("10 minutes", "1 hour", "7 days"). In the form the sentence "valid for …" takes: "7 Tage", "7 napig".
 */
export const validity = (milliseconds: number): Worded => (t) => {
  // A message is worded a moment after its link or code was made, so what is left is a little short of the whole
  // time: the nearest minute is that time again. That half a minute is all that is ever added.
  const minutes = Math.max(1, Math.round(milliseconds / 60_000))
  if (minutes < 60) return t(`duration.for.minute.${form(minutes)}`, { count: minutes })
  // Hours and days are rounded down: 47 and a half hours are 47 hours, not two days.
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return t(`duration.for.hour.${form(hours)}`, { count: hours })
  const days = Math.floor(hours / 24)
  return t(`duration.for.day.${form(days)}`, { count: days })
}

/**
 * What a text gets that says how long to wait: `wait` in words, rounded up to whole minutes, in the form the sentence
 * "again in …" takes ("1 minute", "5 Minuten", "5 perc"); and `minutes`, the bare number such a text had before 0.3.2.
 */
export const waitValues = (seconds: number): { wait: Worded; minutes: number } => {
  const minutes = Math.max(1, Math.ceil(seconds / 60))
  return { wait: (t) => t(`duration.in.minute.${form(minutes)}`, { count: minutes }), minutes }
}

/**
 * The same for a wait that can be a matter of seconds, as the one between two codes: seconds below a minute
 * ("1 second", "45 Sekunden"), whole minutes from there on. `seconds` is the bare number such a text had up to 0.3.2.
 */
export const shortWaitValues = (seconds: number): { wait: Worded; seconds: number } => {
  const left = Math.max(1, Math.ceil(seconds))
  return { wait: left < 60 ? (t) => t(`duration.in.second.${form(left)}`, { count: left }) : waitValues(left).wait, seconds: left }
}

/**
 * The texts that state a time. They get it in words (`worded`). A text replaced through a `locales` folder may leave
 * that value out and write the time itself, and may use the bare number the text had before it was worded (`number`),
 * so a folder written for an earlier version still loads and reads as it did.
 */
export const DURATION_VALUES: Partial<Record<MessageKey, { worded: string; number?: string }>> = {
  'code.sentEmail': { worded: 'validity' },
  'code.sentSms': { worded: 'validity' },
  'reset.sent': { worded: 'validity' },
  'mail.activation.text': { worded: 'validity', number: 'hours' },
  'mail.activationFor.text': { worded: 'validity', number: 'hours' },
  'code.cooldown': { worded: 'wait', number: 'seconds' },
  'phone.wait': { worded: 'wait', number: 'seconds' },
  'code.tooMany': { worded: 'wait', number: 'minutes' },
  'limit.text': { worded: 'wait', number: 'minutes' },
  'account.password.wait': { worded: 'wait', number: 'minutes' },
}

/**
 * The values of a text whose wait came to the page in a message. A message for the next page travels in a cookie
 * and carries the wait as the bare number of seconds (`seconds`): a time in words is no value that can travel, and
 * the sentence itself, which a `locales` folder can make long, has no place in a cookie. The words are put to it
 * here, on the page that shows the text. A text without a wait keeps its values.
 */
export const withWait = (key: MessageKey, values: Values = {}): TextValues => {
  const duration = DURATION_VALUES[key]
  if (duration?.worded !== 'wait' || typeof values.seconds !== 'number') return values
  return { ...values, ...(duration.number === 'seconds' ? shortWaitValues(values.seconds) : waitValues(values.seconds)) }
}
