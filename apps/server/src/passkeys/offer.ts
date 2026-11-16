import { createHash } from 'node:crypto'
import { readCookie, setCookieHeader, sign, unsign } from '../interaction/signed-cookie.js'

const ANSWER_COOKIE = 'pforte_passkey_offer'
const DAY = 24 * 60 * 60
/** "Not now" is good for this long; then the offer may come again. */
export const OFFER_LATER_SECONDS = 90 * DAY
/** A browser in which a passkey was made or used is not asked again. Browsers keep a cookie for 400 days at most; every sign-in with a passkey renews it. */
export const OFFER_DONE_SECONDS = 400 * DAY
/** A browser is shared by few people. The newest answers are kept. */
const MAX_PEOPLE = 8

/** Who answered the offer in this browser, and until when each of them is left alone (seconds since 1970). */
interface Answers {
  purpose: 'passkey-offer-answers'
  people: Record<string, number>
}

/** Stands for a person in the cookie, so that it holds no id of theirs. */
const keyOf = (userId: string) => createHash('sha256').update(`passkey-offer:${userId}`).digest('hex').slice(0, 16)

/**
 * Remembers, per browser and person, that the offer to make a passkey was answered: "not now" for 90 days, a
 * passkey that was made or used for good. So the page does not nag, and a second person at the same browser
 * still gets their own offer.
 */
export const createPasskeyOffers = ({ cookieKeys, secure }: { cookieKeys: string[]; secure: boolean }) => {
  const read = (cookieHeader: string | undefined, now: number) => {
    const answers = unsign<Answers>(cookieKeys, readCookie(cookieHeader, ANSWER_COOKIE))
    if (answers?.purpose !== 'passkey-offer-answers' || typeof answers.people !== 'object' || answers.people === null) return new Map<string, number>()
    return new Map(Object.entries(answers.people).filter(([, until]) => typeof until === 'number' && until > now))
  }

  return {
    /**
     * Whether to offer a passkey now: the script said the device can make one (`capable` is the form field it
     * fills), and this person has not answered in this browser, or their "not now" has run out.
     */
    wanted: (cookieHeader: string | undefined, userId: string, capable: unknown, now = Date.now()) => capable === '1' && !read(cookieHeader, now / 1000).has(keyOf(userId)),

    /** The cookie that notes this person's answer next to the answers of others in this browser. */
    answered: (cookieHeader: string | undefined, userId: string, answer: 'later' | 'done', now = Date.now()) => {
      const seconds = now / 1000
      const people = read(cookieHeader, seconds)
      people.delete(keyOf(userId))
      people.set(keyOf(userId), Math.floor(seconds + (answer === 'done' ? OFFER_DONE_SECONDS : OFFER_LATER_SECONDS)))
      const kept = [...people].slice(-MAX_PEOPLE)
      const value: Answers = { purpose: 'passkey-offer-answers', people: Object.fromEntries(kept) }
      // Read where a sign-in ends; an activation, which lives elsewhere, only ever writes it.
      return setCookieHeader(ANSWER_COOKIE, sign(cookieKeys, value), { path: '/interaction', maxAgeSeconds: OFFER_DONE_SECONDS, secure })
    },
  }
}

export type PasskeyOffers = ReturnType<typeof createPasskeyOffers>
