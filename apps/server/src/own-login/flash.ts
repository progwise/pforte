import type { FastifyReply, FastifyRequest } from 'fastify'
import type { MessageKey, Values } from '../i18n/index.js'
import { readCookie, setCookieHeader, sign, unsign } from '../interaction/signed-cookie.js'

/**
 * A short message for the page the person lands on after an action ("Ben Keller was locked."): what a
 * page can say after it redirected. Either one of our texts with its values, or a text from the API, which says
 * in its own words why it refused.
 */
export interface Flash {
  kind: 'ok' | 'error'
  key?: MessageKey
  values?: Values
  text?: string
  /** The language of the person the message is for, when the page that shows it will not know them any more. */
  language?: string
}

/** The messages of one of pforte's own areas, kept in a cookie of that area. */
export const createFlash = ({ cookie: name, path, sameSite }: { cookie: string; path: string; sameSite?: 'Strict' | 'Lax' }) => {
  const header = (value: string, maxAgeSeconds: number, secure: boolean) => setCookieHeader(name, value, { path, maxAgeSeconds, secure, sameSite })
  const add = (reply: FastifyReply, cookie: string) => {
    const existing = reply.getHeader('set-cookie')
    reply.header('Set-Cookie', [existing ?? [], cookie].flat().map(String))
  }

  return {
    /** Remember a message for the next page, in a signed cookie that is only valid for that moment. */
    set(reply: FastifyReply, cookieKeys: string[], secure: boolean, flash: Flash) {
      add(reply, header(sign(cookieKeys, { ...flash, expiresAt: Date.now() + 2 * 60_000 }), 120, secure))
    },
    /** The message left for this page, if any. Also clears it, so it is shown once. */
    take(request: FastifyRequest, reply: FastifyReply, cookieKeys: string[], secure: boolean) {
      const value = readCookie(request.headers.cookie, name)
      if (value === undefined) return undefined
      const flash = unsign<Flash & { expiresAt: number }>(cookieKeys, value)
      add(reply, header('', 0, secure))
      return flash && flash.expiresAt > Date.now() ? (flash as Flash) : undefined
    },
  }
}
