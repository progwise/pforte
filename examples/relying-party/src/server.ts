// A minimal OpenID Connect relying party: signs users in with pforte (authorization code flow
// with PKCE), shows the claims it receives, refreshes tokens and signs out.
//
// It uses only the standard `openid-client` library and nothing specific to pforte, so the same
// code works against any OpenID provider. Sessions are kept in memory; a real application would
// use a session store.
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import * as client from 'openid-client'

const issuer = new URL(process.env.ISSUER ?? 'http://localhost:3300')
const clientId = process.env.CLIENT_ID ?? 'demo-web'
const port = Number(process.env.PORT ?? 3400)
// The address people reach this application under. Behind a proxy that is not where it listens.
const baseUrl = (process.env.BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, '')
const redirectUri = `${baseUrl}/callback`
const secure = baseUrl.startsWith('https:')
// The language this application asks pforte's pages to be in (`ui_locales`), when it signs somebody in and when it
// signs them out. An application with a language setting of its own passes that; this one has a setting for it.
const uiLocales: Record<string, string> = process.env.UI_LOCALES?.trim() ? { ui_locales: process.env.UI_LOCALES.trim() } : {}

// demo-web is a public client: it has no secret and PKCE protects the authorization code.
// Plain http is only accepted for local development; use an https issuer anywhere else.
const config = await client.discovery(issuer, clientId, undefined, client.None(), {
  execute: issuer.protocol === 'http:' ? [client.allowInsecureRequests] : [],
})

interface Session {
  /** Values of a sign-in that has started but not come back yet. */
  pending?: { verifier: string; state: string; nonce: string }
  tokens?: { accessToken: string; refreshToken?: string; idToken: string; expiresAt: number }
  claims?: Record<string, unknown>
  userinfo?: Record<string, unknown>
}

const sessions = new Map<string, Session>()

/** The session of the request's cookie, if there is one. */
const sessionOf = (request: IncomingMessage) => {
  const id = /(?:^|;\s*)sid=([\w-]+)/.exec(request.headers.cookie ?? '')?.[1]
  const session = id ? sessions.get(id) : undefined
  return id && session ? { id, session } : undefined
}

// A session begins when somebody starts to sign in, not with the first request: a health check, a crawler or a
// visitor who only looks would each leave one behind, and they are never removed.
const startSession = (response: ServerResponse) => {
  const id = randomBytes(24).toString('base64url')
  const session: Session = {}
  sessions.set(id, session)
  response.setHeader('Set-Cookie', `sid=${id}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`)
  return session
}

const escapeHtml = (value: unknown) =>
  String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

// With a manifest the application can be put on a phone's home screen and then runs in a window of its own.
// How a sign-in at another address behaves from there differs between phones, which makes it worth trying.
const manifest = {
  name: 'pforte example application',
  short_name: 'pforte example',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#0b5cad',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
}
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180"><rect width="180" height="180" rx="36" fill="#0b5cad"/><path d="M62 132V48h34a28 28 0 0 1 0 56H62" fill="none" stroke="#fff" stroke-width="16" stroke-linejoin="round"/></svg>`

const page = (body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>pforte example</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#0b5cad">
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 44rem; margin: 2rem auto; padding: 0 1rem; }
  pre { padding: 1rem; overflow-x: auto; background: #f4f5f7; border-radius: 0.4rem; }
  form { display: inline; }
  button, .button { padding: 0.5rem 1rem; font: inherit; color: #fff; background: #0b5cad; border: 0;
    border-radius: 0.3rem; text-decoration: none; cursor: pointer; }
</style></head><body>
<h1>pforte example application</h1>
${body}
</body></html>`

const html = (response: ServerResponse, status: number, body: string) => {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(body))
}

const redirect = (response: ServerResponse, location: string) => {
  response.writeHead(303, { Location: location }).end()
}

const showError = (response: ServerResponse, error: unknown) => {
  console.error(error)
  const message = error instanceof Error ? error.message : String(error)
  html(response, 400, `<p>Something went wrong: ${escapeHtml(message)}</p><p><a href="/">Back</a></p>`)
}

const home = (response: ServerResponse, session: Session | undefined) => {
  if (!session?.tokens || !session.claims) {
    return html(response, 200, `<p>You are not signed in.</p><p><a class="button" href="/login">Sign in</a></p>`)
  }
  const secondsLeft = Math.max(0, Math.round((session.tokens.expiresAt - Date.now()) / 1000))
  html(
    response,
    200,
    `<p>Signed in as <strong>${escapeHtml(session.claims.email ?? session.claims.sub)}</strong>.</p>
<h2>ID token claims</h2>
<pre>${escapeHtml(JSON.stringify(session.claims, null, 2))}</pre>
<h2>Userinfo response</h2>
<pre>${escapeHtml(JSON.stringify(session.userinfo, null, 2))}</pre>
<p>The access token expires in ${secondsLeft} seconds.</p>
<form method="post" action="/refresh"><button>Refresh tokens</button></form>
<form method="post" action="/logout"><button>Sign out</button></form>`,
  )
}

const storeTokens = async (session: Session, tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers) => {
  const claims = tokens.claims()
  if (!claims || !tokens.id_token) throw new Error('The provider did not return an ID token')

  session.tokens = {
    accessToken: tokens.access_token,
    // Refresh tokens rotate: always keep the newest one.
    refreshToken: tokens.refresh_token ?? session.tokens?.refreshToken,
    idToken: tokens.id_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 0) * 1000,
  }
  session.claims = { ...claims }
  session.userinfo = await client.fetchUserInfo(config, tokens.access_token, claims.sub)
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', baseUrl)
  const { id, session } = sessionOf(request) ?? {}

  try {
    if (request.method === 'GET' && url.pathname === '/') {
      return home(response, session)
    }

    if (request.method === 'GET' && url.pathname === '/manifest.webmanifest') {
      return void response.writeHead(200, { 'Content-Type': 'application/manifest+json' }).end(JSON.stringify(manifest))
    }

    if (request.method === 'GET' && url.pathname === '/icon.svg') {
      return void response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' }).end(icon)
    }

    if (request.method === 'GET' && url.pathname === '/login') {
      const verifier = client.randomPKCECodeVerifier()
      const state = client.randomState()
      const nonce = client.randomNonce()
      const starting = session ?? startSession(response)
      starting.pending = { verifier, state, nonce }

      const authorizationUrl = client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: 'openid profile',
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        state,
        nonce,
        ...uiLocales,
      })
      return redirect(response, authorizationUrl.href)
    }

    if (request.method === 'GET' && url.pathname === '/callback') {
      if (!session?.pending) throw new Error('No sign-in is in progress. Start again.')
      const { verifier, state, nonce } = session.pending
      session.pending = undefined

      // Checks the state, the nonce, the PKCE verifier and the ID token's signature and claims.
      const tokens = await client.authorizationCodeGrant(config, url, {
        pkceCodeVerifier: verifier,
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true,
      })
      await storeTokens(session, tokens)
      return redirect(response, '/')
    }

    if (request.method === 'POST' && url.pathname === '/refresh') {
      if (!session?.tokens?.refreshToken) throw new Error('There is no refresh token.')
      await storeTokens(session, await client.refreshTokenGrant(config, session.tokens.refreshToken))
      return redirect(response, '/')
    }

    if (request.method === 'POST' && url.pathname === '/logout') {
      const idToken = session?.tokens?.idToken
      // The application's own session ends here and now: the person comes back from the provider whatever they
      // answer there, and nothing tells the application what the answer was.
      if (id) sessions.delete(id)
      response.setHeader('Set-Cookie', `sid=; Path=/; Max-Age=0${secure ? '; Secure' : ''}`)
      // The provider revokes this application's refresh tokens and asks the person whether to end the sign-in
      // there as well. After a "no" the provider can reuse its session for the next sign-in here.
      const endSession = client.buildEndSessionUrl(config, {
        ...(idToken ? { id_token_hint: idToken } : {}),
        post_logout_redirect_uri: `${baseUrl}/`,
        ...uiLocales,
      })
      return redirect(response, endSession.href)
    }

    html(response, 404, '<p>Not found.</p>')
  } catch (error) {
    showError(response, error)
  }
})

server.listen(port, () => {
  console.log(`Example application: ${baseUrl}  (provider: ${issuer.href}, client: ${clientId})`)
})

// In a container: stop at once when asked to, instead of waiting to be killed.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)))
