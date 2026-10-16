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
const baseUrl = `http://localhost:${port}`
const redirectUri = `${baseUrl}/callback`

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

const sessionFor = (request: IncomingMessage, response: ServerResponse) => {
  const cookie = /(?:^|;\s*)sid=([\w-]+)/.exec(request.headers.cookie ?? '')?.[1]
  if (cookie) {
    const existing = sessions.get(cookie)
    if (existing) return { id: cookie, session: existing }
  }
  const id = randomBytes(24).toString('base64url')
  const session: Session = {}
  sessions.set(id, session)
  response.setHeader('Set-Cookie', `sid=${id}; Path=/; HttpOnly; SameSite=Lax`)
  return { id, session }
}

const escapeHtml = (value: unknown) =>
  String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

const page = (body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>pforte example</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
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

const home = (response: ServerResponse, session: Session) => {
  if (!session.tokens || !session.claims) {
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
  const { id, session } = sessionFor(request, response)

  try {
    if (request.method === 'GET' && url.pathname === '/') {
      return home(response, session)
    }

    if (request.method === 'GET' && url.pathname === '/login') {
      const verifier = client.randomPKCECodeVerifier()
      const state = client.randomState()
      const nonce = client.randomNonce()
      session.pending = { verifier, state, nonce }

      const authorizationUrl = client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: 'openid profile',
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        state,
        nonce,
      })
      return redirect(response, authorizationUrl.href)
    }

    if (request.method === 'GET' && url.pathname === '/callback') {
      if (!session.pending) throw new Error('No sign-in is in progress. Start again.')
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
      if (!session.tokens?.refreshToken) throw new Error('There is no refresh token.')
      await storeTokens(session, await client.refreshTokenGrant(config, session.tokens.refreshToken))
      return redirect(response, '/')
    }

    if (request.method === 'POST' && url.pathname === '/logout') {
      const idToken = session.tokens?.idToken
      sessions.delete(id)
      response.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0')
      // Ending the session at the provider revokes this application's refresh tokens there.
      const endSession = client.buildEndSessionUrl(config, {
        ...(idToken ? { id_token_hint: idToken } : {}),
        post_logout_redirect_uri: `${baseUrl}/`,
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
