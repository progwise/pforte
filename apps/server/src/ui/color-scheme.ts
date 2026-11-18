import type { FastifyInstance } from 'fastify'
import { readCookie, setCookieHeader } from '../interaction/signed-cookie.js'

export const COLOR_SCHEME_COOKIE = 'pforte_color_scheme'
export const COLOR_SCHEME_PARAMETER = 'color_scheme'
/** As long as a browser keeps a cookie at most: what an application said holds until one says something else. */
const SECONDS = 400 * 24 * 60 * 60

export type ColorScheme = 'light' | 'dark'
const isScheme = (value: unknown): value is ColorScheme => value === 'light' || value === 'dark'

/**
 * Whether the pages are light or dark, said by the application a person comes from.
 *
 * An application is light or dark by its own choice, which pforte cannot see. So it says it, with the parameter
 * `color_scheme` in the query of a request that leads to a page: the authorization request, the end-session request,
 * a link to the account pages. That request leaves a cookie, and every page of pforte in that browser has that look
 * from then on, whatever leads to it, until a request says something else: no page has to pass the parameter on.
 * `auto` removes the cookie. Without it the page says nothing and the stylesheet follows the device.
 *
 * The cookie holds one of two words and is checked when read, so it needs no signature. Any site can set it with a
 * link, as any site can send somebody to the sign-in page: it changes the look and nothing else.
 */
export const createColorScheme = ({ secure }: { secure: boolean }) => {
  const cookie = (value: string, maxAgeSeconds: number) => setCookieHeader(COLOR_SCHEME_COOKIE, value, { path: '/', maxAgeSeconds, secure, sameSite: 'Lax' })

  /** What a request says: the look of its page, and the cookie to answer with if it carried the parameter. */
  const of = (method: string, parameter: unknown, cookieHeader: string | undefined): { scheme?: ColorScheme; setCookie?: string } => {
    if (method === 'GET' && isScheme(parameter)) return { scheme: parameter, setCookie: cookie(parameter, SECONDS) }
    if (method === 'GET' && parameter === 'auto') return { setCookie: cookie('', 0) }
    const kept = readCookie(cookieHeader, COLOR_SCHEME_COOKIE)
    return isScheme(kept) ? { scheme: kept } : {}
  }

  /** The page with its look written on it, for the stylesheet. Anything that is not one of pforte's pages stays as it is. */
  const mark = <T>(body: T, scheme: ColorScheme | undefined): T | string =>
    scheme && typeof body === 'string' ? body.replace(/^(<!doctype html>\n<html lang="[^"]*")>/, `$1 data-color-scheme="${scheme}">`) : body

  return {
    of,
    mark,
    /** For every page Fastify sends. The pages of the OpenID library do not pass here: `provider.ts` does the same for them. */
    addTo(app: FastifyInstance) {
      app.addHook('onSend', async (request, reply, payload) => {
        const { scheme, setCookie } = of(request.method, (request.query as Record<string, unknown> | undefined)?.[COLOR_SCHEME_PARAMETER], request.headers.cookie)
        if (setCookie) reply.header('Set-Cookie', setCookie)
        return mark(payload, scheme)
      })
    },
  }
}
