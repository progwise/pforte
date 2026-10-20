import type { AdminHarness } from './admin-harness.js'
import type { Browser } from './browser.js'

/**
 * What a browser does from a first address: follows redirects, and where pforte asks for the password and the code,
 * enters them. Stops at the first page that is not a redirect and returns it.
 */
export const driveSignIn = async (
  h: AdminHarness,
  browser: Browser,
  start = '/manage',
  email = 'admin@example.com',
  { remember = false } = {},
) => {
  let url = start
  const visited: string[] = []
  for (let step = 0; step < 14; step++) {
    const response = await browser.request('GET', url)
    visited.push(new URL(url, 'http://x').pathname)
    if (response.statusCode !== 303) return { response, visited }
    const location = response.headers.location as string
    const path = new URL(location, 'http://x').pathname
    if (/^\/interaction\/[^/]+$/.test(path)) {
      await browser.request('GET', location)
      const password = await browser.request('POST', `${path}/login`, { form: { email, password: 'dev-password' } })
      let next = password.headers.location as string
      if (next.endsWith('/code')) {
        const code = h.notifications.findLast((n) => n.kind === 'login-code' && n.user.email === email)!.code!
        const done = await browser.request('POST', `${path}/code`, { form: { code, ...(remember ? { remember: 'on' } : {}) } })
        next = done.headers.location as string
      }
      url = next
      continue
    }
    url = location
  }
  throw new Error(`too many redirects: ${visited.join(' -> ')}`)
}

/** A browser that is signed in to the administration as this administrator. */
export const signedInToManage = async (h: AdminHarness, browserClass: new (app: AdminHarness['app']) => Browser, email = 'admin@example.com') => {
  const browser = new browserClass(h.app)
  const { response } = await driveSignIn(h, browser, '/manage', email)
  if (response.statusCode !== 200) throw new Error(`signing in to the administration ended with ${response.statusCode}`)
  return browser
}
