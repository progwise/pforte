import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

const codeSources = new WeakMap<FastifyInstance, (email: string) => string | undefined>()

/** Tells `signIn` where to read the sign-in code of an app from, e.g. the e-mail the notifier recorded. */
export const registerCodeSource = (app: FastifyInstance, source: (email: string) => string | undefined) => {
  codeSources.set(app, source)
}

/** A minimal browser for driving the provider through `app.inject`: it keeps cookies between requests. */
export class Browser {
  readonly cookies = new Map<string, string>()

  constructor(readonly app: FastifyInstance) {}

  private store(setCookie: string | string[] | undefined) {
    for (const header of [setCookie ?? []].flat()) {
      const [pair, ...attributes] = header.split(';')
      const separator = pair!.indexOf('=')
      const name = pair!.slice(0, separator).trim()
      const value = pair!.slice(separator + 1).trim()
      const expired = attributes.some((attribute) => /^\s*expires=/i.test(attribute) && new Date(attribute.split('=')[1]!) < new Date())
      if (!value || expired) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }

  async request(
    method: 'GET' | 'POST',
    url: string,
    { form, headers }: { form?: Record<string, string>; headers?: Record<string, string> } = {},
  ) {
    const target = new URL(url, 'http://localhost:3300')
    const response = await this.app.inject({
      method,
      url: target.pathname + target.search,
      headers: {
        ...(this.cookies.size
          ? { cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ') }
          : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
      payload: form ? new URLSearchParams(form).toString() : undefined,
    })
    this.store(response.headers['set-cookie'])
    return response
  }
}

export const pkcePair = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export const basicAuth = (clientId: string, secret: string) =>
  `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`

export interface AuthorizeOptions {
  clientId: string
  redirectUri: string
  scope?: string
  email?: string
  password?: string
  /** Stop at the code page instead of entering the code. */
  stopAtCode?: boolean
}

/** Runs authorization → login → redirect with a code. Returns the code and the PKCE verifier. */
export const signIn = async (
  browser: Browser,
  { clientId, redirectUri, scope = 'openid', email = 'anna.schmidt@example.com', password = 'dev-password', stopAtCode = false }: AuthorizeOptions,
) => {
  const { verifier, challenge } = pkcePair()
  const nonce = randomBytes(8).toString('hex')
  const state = randomBytes(8).toString('hex')
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })

  const authorize = await browser.request('GET', `/auth?${query}`)
  const interactionUrl = authorize.headers.location as string
  const loginPage = await browser.request('GET', interactionUrl)
  const passwordStep = await browser.request('POST', `${interactionUrl}/login`, { form: { email, password } })
  let login = passwordStep
  if (passwordStep.statusCode === 303 && (passwordStep.headers.location as string).endsWith('/code')) {
    // The password was right: the second factor follows. Enter the code the app sent.
    const codePage = await browser.request('GET', passwordStep.headers.location as string)
    if (stopAtCode) return { login: passwordStep, loginPage, codePage, verifier, nonce, state }
    const code = codeSources.get(browser.app)?.(email)
    if (!code) throw new Error(`No sign-in code was sent to ${email}, or no code source is registered for this app.`)
    login = await browser.request('POST', `${interactionUrl}/code`, { form: { code } })
  }
  if (login.statusCode !== 303) {
    return { login, loginPage, verifier, nonce, state }
  }
  const resumed = await browser.request('GET', login.headers.location as string)
  const callback = new URL(resumed.headers.location as string)
  return { login, loginPage, resumed, callback, code: callback.searchParams.get('code'), verifier, nonce, state }
}

/** Decodes a JWT and checks its RS256 signature against the provider's published keys. */
export const verifyJwt = async (app: FastifyInstance, token: string) => {
  const [header, payload, signature] = token.split('.') as [string, string, string]
  const { keys } = (await app.inject({ method: 'GET', url: '/jwks' })).json()
  const key = createPublicKey({ key: keys[0], format: 'jwk' })
  const valid = verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), key, Buffer.from(signature, 'base64url'))
  return { valid, header: JSON.parse(Buffer.from(header, 'base64url').toString()), claims: JSON.parse(Buffer.from(payload, 'base64url').toString()) }
}
