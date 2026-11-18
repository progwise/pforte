import { readCookie, setCookieHeader, sign, unsign } from '../interaction/signed-cookie.js'

export const LOGOUT_LANGUAGE_COOKIE = 'pforte_logout_language'
/** As long as a sign-in may take on its way: time to read the question and answer it. */
const SECONDS = 10 * 60

/**
 * The language of a sign-out, on its way from the request to the page that ends it.
 *
 * The request says which language the application asked for and whose sign-in it is about. The page at the end
 * knows neither: the request that reaches it carries nothing, and after a "yes" the session is gone. So the language
 * chosen for the question travels in a cookie. It is for every path, because the page at the end can be the
 * provider's own notice or the "signed out" page of the account pages or of the administration.
 */
export const createLogoutLanguage = ({ cookieKeys, secure }: { cookieKeys: string[]; secure: boolean }) => {
  // Lax as the cookies of the account pages: a sign-out starts at the site of an application.
  const cookie = (value: string, maxAgeSeconds: number) => setCookieHeader(LOGOUT_LANGUAGE_COOKIE, value, { path: '/', maxAgeSeconds, secure, sameSite: 'Lax' })

  return {
    /** The `Set-Cookie` header that keeps the language for the page at the end. */
    remember: (language: string) => cookie(sign(cookieKeys, { language, expiresAt: Date.now() + SECONDS * 1000 }), SECONDS),
    /** The language a sign-out left behind, from the `Cookie` header of a request. */
    read: (cookieHeader: string | undefined) => {
      const kept = unsign<{ language: string; expiresAt: number }>(cookieKeys, readCookie(cookieHeader, LOGOUT_LANGUAGE_COOKIE))
      return kept && kept.expiresAt > Date.now() ? kept.language : undefined
    },
    /** The `Set-Cookie` header of the page at the end: the sign-out is over. */
    forget: () => cookie('', 0),
  }
}

export type LogoutLanguage = ReturnType<typeof createLogoutLanguage>
