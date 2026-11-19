// A minimal OpenID Connect relying party: signs users in with pforte (authorization code flow
// with PKCE), shows the claims it receives, refreshes tokens and signs out.
//
// The sign-in uses only the standard `openid-client` library and nothing specific to pforte, so the
// same code works against any OpenID provider. Sessions are kept in memory; a real application would
// use a session store. Its page also has a list of things to try at pforte, each with a button: that
// list knows pforte's own pages (`atPforte` below) and is of no use with another provider.
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
// demo-web is a public client: it has no secret and PKCE protects the authorization code.
// Plain http is only accepted for local development; use an https issuer anywhere else.
const config = await client.discovery(issuer, clientId, undefined, client.None(), {
  execute: issuer.protocol === 'http:' ? [client.allowInsecureRequests] : [],
})

// What this application says about itself with every request that leads to one of pforte's pages: the language it
// is in (`ui_locales`, a standard parameter) and whether it is light or dark (`color_scheme`, pforte's own; pforte's
// pages then look like it, and stay so in that browser until an application says something else). An application
// passes its own state. This one has a switch on its page for each, kept in a cookie, so that every case can be
// tried from a phone; UI_LOCALES and COLOR_SCHEME say what holds until a switch is used.
const NOTHING = 'none'
const offered = config.serverMetadata().ui_locales_supported
const switches = {
  color_scheme: { label: 'Look', choices: ['light', 'dark', 'auto'], preset: process.env.COLOR_SCHEME?.trim() },
  ui_locales: {
    label: 'Language',
    choices: Array.isArray(offered) ? offered.filter((language) => typeof language === 'string') : [],
    preset: process.env.UI_LOCALES?.trim(),
  },
}
type Said = Partial<Record<keyof typeof switches, string>>

const cookieOf = (request: IncomingMessage, name: string) =>
  new RegExp(`(?:^|;\\s*)${name}=([\\w-]+)`).exec(request.headers.cookie ?? '')?.[1]

/** The parameters this application adds, as the switches stand in this browser. */
const saidBy = (request: IncomingMessage) => {
  const said: Said = {}
  for (const [name, { choices, preset }] of Object.entries(switches)) {
    const chosen = cookieOf(request, `says_${name}`)
    const value = chosen !== undefined && [NOTHING, ...choices].includes(chosen) ? chosen : preset
    if (value && value !== NOTHING) said[name as keyof Said] = value
  }
  return said
}

// The one part that knows pforte: the addresses of its own pages, which are no part of OpenID Connect.
const atPforte = (path: string, parameters: Record<string, string> = {}) => {
  const address = new URL(`${issuer.href.replace(/\/$/, '')}${path}`)
  for (const [name, value] of Object.entries(parameters)) address.searchParams.set(name, value)
  return address.href
}

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
  const id = cookieOf(request, 'sid')
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

// The application is as light or dark as it says it is, and follows the device where it says nothing or `auto`.
const page = (body: string, said: Said) => `<!doctype html>
<html lang="en"${said.color_scheme === 'light' || said.color_scheme === 'dark' ? ` data-look="${said.color_scheme}"` : ''}><head><meta charset="utf-8"><title>pforte example</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#0b5cad">
<style>
  :root { color-scheme: light dark; }
  :root[data-look="light"] { color-scheme: light; }
  :root[data-look="dark"] { color-scheme: dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 44rem; margin: 2rem auto; padding: 0 1rem; }
  pre { padding: 1rem; overflow-x: auto; background: light-dark(#f4f5f7, #1b2027); border-radius: 0.4rem; }
  code { overflow-wrap: anywhere; }
  form { display: inline; }
  button, .button { display: inline-block; padding: 0.5rem 1rem; font: inherit; color: #fff; background: #0b5cad;
    border: 0; border-radius: 0.3rem; text-decoration: none; cursor: pointer; }
  .switch { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .switch span { width: 100%; }
  .switch a { padding: 0.4rem 0.9rem; color: inherit; text-decoration: none; border: 1px solid; border-radius: 0.3rem; }
  .switch a[aria-current] { color: #fff; background: #0b5cad; border-color: #0b5cad; }
  .try { padding: 0; list-style: none; }
  .try li { margin: 1.25rem 0; }
  .try p { margin: 0.4rem 0 0; }
</style></head><body>
<h1>pforte example application</h1>
${body}
</body></html>`

const html = (response: ServerResponse, status: number, body: string, said: Said) => {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(body, said))
}

const redirect = (response: ServerResponse, location: string) => {
  response.writeHead(303, { Location: location }).end()
}

const showError = (response: ServerResponse, error: unknown, said: Said) => {
  console.error(error)
  const message = error instanceof Error ? error.message : String(error)
  html(response, 400, `<p>Something went wrong: ${escapeHtml(message)}</p><p><a href="/">Back</a></p>`, said)
}

/** The two switches, and what they make this application send. */
const whatItSays = (said: Said) => {
  const rows = Object.entries(switches).map(([name, { label, choices }]) => {
    const current = said[name as keyof Said] ?? NOTHING
    const links = [NOTHING, ...choices].map(
      (choice) =>
        `<a href="/say?${name}=${encodeURIComponent(choice)}"${choice === current ? ' aria-current="true"' : ''}>${escapeHtml(choice === NOTHING ? 'nothing' : choice)}</a>`,
    )
    return `<p class="switch"><span>${label}:</span> ${links.join(' ')}</p>`
  })
  const sent = new URLSearchParams(said).toString()
  return `<h2>What this application tells pforte</h2>
${rows.join('\n')}
<p>${sent ? `Sent with the sign-in and the sign-out: <code>${escapeHtml(sent)}</code>. The links to pforte's own pages carry the look.` : 'Nothing is sent: pforte chooses the language by the person and the browser.'}
pforte keeps the look in the browser. After <code>dark</code> its pages stay dark, also for a request that says
nothing, until one says <code>light</code> or <code>auto</code> (as the device is set).</p>`
}

/** Things to try at pforte, each with its button and what to look at. */
const thingsToTry = (said: Said, signedIn: boolean) => {
  const look: Record<string, string> = said.color_scheme ? { color_scheme: said.color_scheme } : {}
  // pforte's own pages take one language (`lang`), the first of the list.
  const language: Record<string, string> = said.ui_locales ? { lang: said.ui_locales.split(' ')[0]! } : {}
  const link = (href: string, label: string) => `<a class="button" href="${escapeHtml(href)}">${label}</a>`
  const button = (action: string, label: string) => `<form method="post" action="${action}"><button>${label}</button></form>`
  const things = [
    ...(signedIn
      ? [
          [button('/refresh', 'Refresh tokens'), 'A new access token and ID token, without a page of pforte.'],
          [
            button('/logout', 'Sign out'),
            'pforte asks whether to sign out there as well. The question and the page after it come in the language and the look chosen above.',
          ],
        ]
      : [
          [
            link('/login', 'Sign in'),
            'The sign-in pages come in the language and the look chosen above. A browser that is still signed in at pforte comes back at once.',
          ],
        ]),
    [
      link(atPforte('/account', look), 'Your account'),
      'The account pages of pforte. On a narrow screen their bar is one line, the logo and a menu, and signing out is the last entry of the menu.',
    ],
    [
      link(atPforte('/manage', look), 'Administration'),
      'For administrators. Under Users, "Send activation link" and "Reset password" ask which application the person is going to, among those registered with a start address. The page at the end of the link then leads on to it.',
    ],
    [
      link(atPforte('/reset', { client_id: clientId, ...language, ...look }), 'Set or reset the password'),
      'The page that sends a link or a code to choose a password. Its last page leads back here, if this application is registered with a start address.',
    ],
  ]
  return `<h2>Things to try</h2>
<ul class="try">
${things.map(([control, text]) => `<li>${control}<p>${text}</p></li>`).join('\n')}
</ul>`
}

const home = (response: ServerResponse, session: Session | undefined, said: Said) => {
  if (!session?.tokens || !session.claims) {
    return html(response, 200, `<p>You are not signed in.</p>\n${whatItSays(said)}\n${thingsToTry(said, false)}`, said)
  }
  const secondsLeft = Math.max(0, Math.round((session.tokens.expiresAt - Date.now()) / 1000))
  html(
    response,
    200,
    `<p>Signed in as <strong>${escapeHtml(session.claims.email ?? session.claims.sub)}</strong>.</p>
${whatItSays(said)}
${thingsToTry(said, true)}
<h2>ID token claims</h2>
<pre>${escapeHtml(JSON.stringify(session.claims, null, 2))}</pre>
<h2>Userinfo response</h2>
<pre>${escapeHtml(JSON.stringify(session.userinfo, null, 2))}</pre>
<p>The access token expires in ${secondsLeft} seconds.</p>`,
    said,
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
  const said = saidBy(request)

  try {
    if (request.method === 'GET' && url.pathname === '/') {
      return home(response, session, said)
    }

    // A switch on the page: remembers the choice in this browser and shows the page again.
    if (request.method === 'GET' && url.pathname === '/say') {
      const cookies = Object.entries(switches).flatMap(([name, { choices }]) => {
        const choice = url.searchParams.get(name)
        if (choice === null || ![NOTHING, ...choices].includes(choice)) return []
        return [`says_${name}=${choice}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`]
      })
      if (cookies.length > 0) response.setHeader('Set-Cookie', cookies)
      return redirect(response, '/')
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
        ...said,
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
        ...said,
      })
      return redirect(response, endSession.href)
    }

    html(response, 404, '<p>Not found.</p>', said)
  } catch (error) {
    showError(response, error, said)
  }
})

server.listen(port, () => {
  console.log(`Example application: ${baseUrl}  (provider: ${issuer.href}, client: ${clientId})`)
})

// In a container: stop at once when asked to, instead of waiting to be killed.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)))
