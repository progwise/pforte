import { createHash } from 'node:crypto'
import { createBrowserAnswers } from './browser-answers.js'

const LATER_COOKIE = 'pforte_phone_later'
/** "Not now" is good for this long; then a sign-in in this browser asks again. */
export const PHONE_LATER_SECONDS = 30 * 24 * 60 * 60

/**
 * Stands for a person and their number in the cookie, so that it holds neither. With the number in it, "not now"
 * was said about that number: when the back office changes it, the person is asked about the new one.
 */
const keyOf = ({ id, phone }: { id: string; phone: string }) => createHash('sha256').update(`phone-step:${id}:${phone}`).digest('hex').slice(0, 16)

/**
 * Remembers, per browser, who answered "not now" when they were asked to confirm their phone number, so that the
 * next sign-ins there go straight on: at a sign-in, and at the end of an activation, where skipping the step is
 * the same answer. Somebody who confirmed is not asked again anyway: there is nothing left to confirm.
 */
export const createPhoneReminder = ({ cookieKeys, secure }: { cookieKeys: string[]; secure: boolean }) => {
  // For all of pforte: a sign-in reads and writes it under /interaction, an activation writes it under /activate.
  const answers = createBrowserAnswers({ cookieKeys, secure, cookie: LATER_COOKIE, purpose: 'phone-step-answers', path: '/', maxAgeSeconds: PHONE_LATER_SECONDS })

  return {
    /** Whether this person may be asked in this browser now. */
    due: (cookieHeader: string | undefined, user: { id: string; phone: string }, now = Date.now()) => !answers.has(cookieHeader, keyOf(user), now),

    /** The cookie that notes this person's "not now" for this number. */
    later: (cookieHeader: string | undefined, user: { id: string; phone: string }, now = Date.now()) => answers.note(cookieHeader, keyOf(user), PHONE_LATER_SECONDS, now),
  }
}
