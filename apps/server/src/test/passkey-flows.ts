import { expect } from 'vitest'
import type { AdminHarness } from './admin-harness.js'
import type { Authenticator, CreationQuestion, SignInQuestion } from './authenticator.js'
import { Browser, pkcePair } from './browser.js'
import { driveSignIn } from './manage-session.js'

export const WEB = { clientId: 'demo-web', redirectUri: 'http://localhost:3400/callback' }
/** A browser that is known to pforte's rules about where a form comes from, and has a name. */
export const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'

const unescape = (html: string) => html.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')

/** What a page asks the device: the JSON in the attribute of the form the script looks for. */
export const questionIn = <Question>(body: string, kind: 'create' | 'get') => {
  const form = new RegExp(`<form[^>]*data-passkey="${kind}"[^>]*>`).exec(body)?.[0]
  const options = form && /data-options="([^"]*)"/.exec(form)?.[1]
  if (!options) throw new Error(`the page has no form that asks a device to ${kind} a passkey`)
  return JSON.parse(unescape(options)) as Question
}

/** Posts a form as pforte's own page would. */
export const post = (browser: Browser, url: string, form: Record<string, string> = {}, userAgent = IPHONE) =>
  browser.request('POST', url, { form, headers: { 'sec-fetch-site': 'same-origin', 'user-agent': userAgent } })

/** Gives a person a passkey on this device, the way they would on their account pages. Returns its id at the device. */
export const enrol = async (h: AdminHarness, device: Authenticator, email: string) => {
  const browser = new Browser(h.app)
  const { response } = await driveSignIn(h, browser, '/account', email)
  expect(response.statusCode, response.body).toBe(200)
  const page = await browser.request('GET', '/account/passkeys/new')
  expect(page.statusCode, page.body).toBe(200)
  const added = await post(browser, '/account/passkeys/new', { credential: JSON.stringify(device.create(questionIn<CreationQuestion>(page.body, 'create'))) })
  expect(added.statusCode).toBe(303)
  await h.settle()
  return device.newest!
}

/** Starts a sign-in to an application and returns the login page pforte shows, with what it asks a device. */
export const openLogin = async (browser: Browser, { clientId = WEB.clientId, redirectUri = WEB.redirectUri, extra = {} as Record<string, string> } = {}) => {
  const { verifier, challenge } = pkcePair()
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid', code_challenge: challenge, code_challenge_method: 'S256', ui_locales: 'en', ...extra })
  const authorize = await browser.request('GET', `/auth?${query}`)
  expect(authorize.statusCode, authorize.body).toBe(303)
  const interaction = authorize.headers.location as string
  const page = await browser.request('GET', interaction)
  expect(page.statusCode, page.body).toBe(200)
  return { interaction, page, verifier, question: questionIn<SignInQuestion>(page.body, 'get') }
}

/** Follows a finished sign-in back to the application and takes its tokens, as the application does. */
export const tokensAfter = async (browser: Browser, finished: { statusCode: number; headers: Record<string, unknown> }, verifier: string, { clientId = WEB.clientId, redirectUri = WEB.redirectUri } = {}) => {
  expect(finished.statusCode).toBe(303)
  const resumed = await browser.request('GET', finished.headers.location as string)
  expect(resumed.statusCode, resumed.body).toBe(303)
  const code = new URL(resumed.headers.location as string).searchParams.get('code')
  expect(code, String(resumed.headers.location)).toBeTruthy()
  const response = await browser.request('POST', '/token', { form: { grant_type: 'authorization_code', code: code!, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier } })
  expect(response.statusCode, response.body).toBe(200)
  const { id_token: idToken } = response.json() as { id_token: string }
  return { claims: JSON.parse(Buffer.from(idToken.split('.')[1]!, 'base64url').toString()) as Record<string, unknown> }
}
