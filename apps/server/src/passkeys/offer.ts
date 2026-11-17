import { createHash } from 'node:crypto'
import { createBrowserAnswers } from '../interaction/browser-answers.js'

const ANSWER_COOKIE = 'pforte_passkey_offer'
const DAY = 24 * 60 * 60
/** "Not now" is good for this long; then the offer may come again. */
export const OFFER_LATER_SECONDS = 90 * DAY
/** A browser in which a passkey was made or used is not asked again. Browsers keep a cookie for 400 days at most; every sign-in with a passkey renews it. */
export const OFFER_DONE_SECONDS = 400 * DAY

/** Stands for a person in the cookie, so that it holds no id of theirs. */
const keyOf = (userId: string) => createHash('sha256').update(`passkey-offer:${userId}`).digest('hex').slice(0, 16)

/**
 * Remembers, per browser and person, that the offer to make a passkey was answered: "not now" for 90 days, a
 * passkey that was made or used for good. So the page does not nag, and a second person at the same browser
 * still gets their own offer.
 */
export const createPasskeyOffers = ({ cookieKeys, secure }: { cookieKeys: string[]; secure: boolean }) => {
  // For all of pforte: a sign-in reads and writes it under /interaction, an activation under /activate. With a
  // narrower path the one would not be sent the cookie the other wrote, and would overwrite what it could not see.
  const answers = createBrowserAnswers({ cookieKeys, secure, cookie: ANSWER_COOKIE, purpose: 'passkey-offer-answers', path: '/', maxAgeSeconds: OFFER_DONE_SECONDS })

  return {
    /**
     * Whether to offer a passkey now: the script said the device can make one (`capable` is the form field it
     * fills), and this person has not answered in this browser, or their "not now" has run out.
     */
    wanted: (cookieHeader: string | undefined, userId: string, capable: unknown, now = Date.now()) => capable === '1' && !answers.has(cookieHeader, keyOf(userId), now),

    /** The cookie that notes this person's answer next to the answers of others in this browser. */
    answered: (cookieHeader: string | undefined, userId: string, answer: 'later' | 'done', now = Date.now()) =>
      answers.note(cookieHeader, keyOf(userId), answer === 'done' ? OFFER_DONE_SECONDS : OFFER_LATER_SECONDS, now),
  }
}

export type PasskeyOffers = ReturnType<typeof createPasskeyOffers>
