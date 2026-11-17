import { readCookie, setCookieHeader, sign, unsign } from './signed-cookie.js'

/** A browser is shared by few people. The newest answers are kept. */
const MAX_PEOPLE = 8

/** Who answered a question in this browser, and until when each of them is left alone (seconds since 1970). */
interface Answers {
  purpose: string
  people: Record<string, number>
}

/**
 * Remembers in a signed cookie, per browser, who has answered a question that pforte asks after a sign-in, and
 * until when each of them is not asked again. So a page does not nag, and a second person at the same browser
 * is still asked. `key` stands for the person: a hash, so that the cookie holds no id of theirs.
 */
export const createBrowserAnswers = ({
  cookieKeys,
  secure,
  cookie,
  purpose,
  path,
  maxAgeSeconds,
}: {
  cookieKeys: string[]
  secure: boolean
  /** The name of the cookie. */
  cookie: string
  /** What the cookie is for, signed with it: an answer to one question is not one to another. */
  purpose: string
  path: string
  /** How long the browser keeps the cookie: the longest any answer in it is good for. */
  maxAgeSeconds: number
}) => {
  const read = (cookieHeader: string | undefined, seconds: number) => {
    const answers = unsign<Answers>(cookieKeys, readCookie(cookieHeader, cookie))
    if (answers?.purpose !== purpose || typeof answers.people !== 'object' || answers.people === null) return new Map<string, number>()
    return new Map(Object.entries(answers.people).filter(([, until]) => typeof until === 'number' && until > seconds))
  }

  return {
    /** Whether this person has answered here and is still left alone. */
    has: (cookieHeader: string | undefined, key: string, now = Date.now()) => read(cookieHeader, now / 1000).has(key),

    /** The cookie that notes this person's answer, good for `seconds`, next to the answers of others in this browser. */
    note: (cookieHeader: string | undefined, key: string, seconds: number, now = Date.now()) => {
      const people = read(cookieHeader, now / 1000)
      people.delete(key)
      people.set(key, Math.floor(now / 1000 + seconds))
      const value: Answers = { purpose, people: Object.fromEntries([...people].slice(-MAX_PEOPLE)) }
      return setCookieHeader(cookie, sign(cookieKeys, value), { path, maxAgeSeconds, secure })
    },
  }
}
