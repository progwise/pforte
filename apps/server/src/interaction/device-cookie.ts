import { DEVICE_LIFETIME_MS } from '@progwise/pforte-db/devices'
import { readCookie, setCookieHeader } from './signed-cookie.js'

/** Holds the tokens of remembered devices. Tokens are base64url, so a dot cannot occur inside one. */
export const DEVICE_COOKIE = 'pforte_device'
/**
 * Holds the token of a device that was remembered outside a sign-in, by an activation. That page is not under
 * `/interaction`, so the browser does not show it the tokens already there and it cannot add to them. It leaves
 * its token here, and the next sign-in moves it over.
 */
export const NEW_DEVICE_COOKIE = 'pforte_device_new'
/** One browser can be used by several people; each keeps a token, the newest few are kept. */
export const MAX_DEVICE_TOKENS = 5

const DEVICE_PATH = '/interaction'
const lifetime = (secure: boolean) => ({ path: DEVICE_PATH, maxAgeSeconds: DEVICE_LIFETIME_MS / 1000, secure })

const kept = (cookieHeader: string | undefined) => (readCookie(cookieHeader, DEVICE_COOKIE) ?? '').split('.').filter(Boolean).slice(0, MAX_DEVICE_TOKENS)
/** One token at most, and only what a token can look like: the value ends up in another cookie. */
const added = (cookieHeader: string | undefined) => {
  const token = readCookie(cookieHeader, NEW_DEVICE_COOKIE) ?? ''
  return /^[\w-]+$/.test(token) ? [token] : []
}

/** The tokens this browser holds: those kept from earlier sign-ins and the one an activation left. */
export const deviceTokens = (cookieHeader: string | undefined) => [...new Set([...kept(cookieHeader), ...added(cookieHeader)])]

/** The cookie with the tokens, the newest last; the oldest go when there are too many. */
export const deviceCookie = (tokens: string[], secure: boolean) => setCookieHeader(DEVICE_COOKIE, tokens.slice(-MAX_DEVICE_TOKENS).join('.'), lifetime(secure))

/** The cookie an activation sets for the device it remembered. */
export const newDeviceCookie = (token: string, secure: boolean) => setCookieHeader(NEW_DEVICE_COOKIE, token, lifetime(secure))

/** The cookies that move the token an activation left to the others, or none if there is no such token. */
export const adoptNewDevice = (cookieHeader: string | undefined, secure: boolean) =>
  added(cookieHeader).length > 0
    ? [deviceCookie(deviceTokens(cookieHeader), secure), setCookieHeader(NEW_DEVICE_COOKIE, '', { path: DEVICE_PATH, maxAgeSeconds: 0, secure })]
    : []
