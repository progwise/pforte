import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

const codeSources = new WeakMap<FastifyInstance, (email: string) => string | undefined>()

/** Tells `signIn` where to read the sign-in code of an app from, e.g. the e-mail the notifier recorded. */
export const registerCodeSource = (app: FastifyInstance, source: (email: string) => string | undefined) => {
  codeSources.set(app, source)
}

/**
 * A minimal browser for driving the provider through `app.inject`: it keeps cookies between requests and, as a
 * browser does, sends a cookie only to the paths it was set for. One cookie per name: where pforte sets the same
 * name for several paths (one per sign-in), the newest counts.
 */
export interface Multipart {
  fields?: Record<string, string>
  file?: { field?: string; name: string; content: Buffer | string }
}

/** A `multipart/form-data` body, as a browser sends it for a form with a file. */
const multipartBody = ({ fields = {}, file }: Multipart) => {
  const boundary = `----pforte-test-${randomBytes(8).toString('hex')}`
  const parts: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'file'}"; filename="${file.name}"\r\nContent-Type: text/csv\r\n\r\n`))
    parts.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content))
    parts.push(Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(parts) }
}

export class Browser {
  readonly cookies = new Map<string, string>()
  /** The `Path` each cookie was set with. A cookie a test puts into `cookies` itself has none and goes everywhere. */
  private readonly paths = new Map<string, string>()

  constructor(readonly app: FastifyInstance) {}

  /** Whether a browser would send the cookie along with a request for this path (RFC 6265, 5.1.4). */
  private sends(name: string, requestPath: string) {
    const path = this.paths.get(name) ?? '/'
    return requestPath === path || (requestPath.startsWith(path) && (path.endsWith('/') || requestPath[path.length] === '/'))
  }

  private store(setCookie: string | string[] | undefined) {
    for (const header of [setCookie ?? []].flat()) {
      const [pair, ...attributes] = header.split(';')
      const separator = pair!.indexOf('=')
      const name = pair!.slice(0, separator).trim()
      const value = pair!.slice(separator + 1).trim()
      const expired = attributes.some((attribute) => /^\s*expires=/i.test(attribute) && new Date(attribute.split('=')[1]!) < new Date())
      if (!value || expired) {
        this.cookies.delete(name)
        this.paths.delete(name)
      } else {
        this.cookies.set(name, value)
        const path = attributes.map((attribute) => /^\s*path=(.*)$/i.exec(attribute)?.[1]?.trim()).find(Boolean)
        if (path) this.paths.set(name, path)
        else this.paths.delete(name)
      }
    }
  }

  async request(
    method: 'GET' | 'POST',
    url: string,
    { form, multipart, headers, ip }: { form?: Record<string, string | string[]>; multipart?: Multipart; headers?: Record<string, string>; ip?: string } = {},
  ) {
    const target = new URL(url, 'http://localhost:3300')
    const upload = multipart && multipartBody(multipart)
    const sent = [...this.cookies].filter(([name]) => this.sends(name, target.pathname))
    const response = await this.app.inject({
      method,
      url: target.pathname + target.search,
      headers: {
        ...(sent.length ? { cookie: sent.map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(upload ? { 'content-type': upload.contentType } : {}),
        ...headers,
      },
      payload: upload ? upload.body : form ? new URLSearchParams(Object.entries(form).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((item) => [name, item] as [string, string]))).toString() : undefined,
      remoteAddress: ip,
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
