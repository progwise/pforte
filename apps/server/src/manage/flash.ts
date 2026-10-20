import type { FastifyReply, FastifyRequest } from 'fastify'
import type { MessageKey, Values } from '../i18n/index.js'
import { readCookie, setCookieHeader, sign, unsign } from '../interaction/signed-cookie.js'
import { MANAGE_PATH } from './constants.js'

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
}

const COOKIE = 'pforte_manage_flash'

/** Remember a message for the next page, in a signed cookie that is only valid for that moment. */
export const setFlash = (reply: FastifyReply, cookieKeys: string[], secure: boolean, flash: Flash) => {
  const cookie = setCookieHeader(COOKIE, sign(cookieKeys, { ...flash, expiresAt: Date.now() + 2 * 60_000 }), {
    path: MANAGE_PATH,
    maxAgeSeconds: 120,
    secure,
  })
  const existing = reply.getHeader('set-cookie')
  reply.header('Set-Cookie', [existing ?? [], cookie].flat().map(String))
}

/** The message left for this page, if any. Also clears it, so it is shown once. */
export const takeFlash = (request: FastifyRequest, reply: FastifyReply, cookieKeys: string[], secure: boolean) => {
  const flash = unsign<Flash & { expiresAt: number }>(cookieKeys, readCookie(request.headers.cookie, COOKIE))
  if (readCookie(request.headers.cookie, COOKIE) === undefined) return undefined
  const clear = setCookieHeader(COOKIE, '', { path: MANAGE_PATH, maxAgeSeconds: 0, secure })
  const existing = reply.getHeader('set-cookie')
  reply.header('Set-Cookie', [existing ?? [], clear].flat().map(String))
  return flash && flash.expiresAt > Date.now() ? (flash as Flash) : undefined
}
