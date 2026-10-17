import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

const escapeMap: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => escapeMap[char] as string)

const css = `
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1rem;
    font: 16px/1.5 system-ui, sans-serif; background: #f4f5f7; color: #1b1f24; }
  main { width: 100%; max-width: 24rem; background: #fff; padding: 2rem; border-radius: 0.5rem;
    box-shadow: 0 1px 4px rgb(0 0 0 / 15%); }
  h1 { margin: 0 0 1.5rem; font-size: 1.4rem; }
  label { display: block; margin-bottom: 0.25rem; font-weight: 600; }
  input { width: 100%; padding: 0.6rem; margin-bottom: 1rem; font: inherit; border: 1px solid #8c959f; border-radius: 0.3rem; }
  button { width: 100%; padding: 0.7rem; font: inherit; font-weight: 600; color: #fff; background: #0b5cad;
    border: 0; border-radius: 0.3rem; cursor: pointer; }
  label.check { display: flex; gap: 0.5rem; align-items: flex-start; margin-bottom: 1rem; font-weight: 400; }
  label.check input { width: auto; margin: 0.3rem 0 0; }
  button.secondary { margin-top: 0.5rem; color: #0b5cad; background: transparent; }
  a { color: #0b5cad; }
  .error { margin-bottom: 1rem; padding: 0.6rem; color: #82071e; background: #ffebe9; border-radius: 0.3rem; }
`

/** Content-Security-Policy for the pages below: no scripts, and only this exact stylesheet. */
export const contentSecurityPolicy = [
  "default-src 'none'",
  `style-src 'sha256-${createHash('sha256').update(css).digest('base64')}'`,
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ')

/** Headers for every page with a form: nothing is cached or sent along as referrer, and nothing but our own styles loads. */
export const addPageHeaders = (app: FastifyInstance) => {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
    reply.header('Content-Security-Policy', contentSecurityPolicy)
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
  })
}

const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`

export interface LoginPageOptions {
  uid: string
  clientName?: string
  email?: string
  error?: string
}

export const loginPage = ({ uid, clientName, email = '', error }: LoginPageOptions) =>
  page(
    'Sign in',
    `<h1>Sign in${clientName ? ` to ${escapeHtml(clientName)}` : ''}</h1>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/interaction/${encodeURIComponent(uid)}/login">
<label for="email">E-mail</label>
<input id="email" name="email" type="email" autocomplete="username" required autofocus value="${escapeHtml(email)}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button>
</form>
<p><a href="/reset">Forgot your password?</a></p>
<form method="post" action="/interaction/${encodeURIComponent(uid)}/abort">
<button type="submit" class="secondary">Cancel</button>
</form>`,
  )

export const errorPage = (title: string, message: string) =>
  page(title, `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>`)

export interface CodePageOptions {
  uid: string
  /** Where the code went, already masked. */
  sentTo: string
  error?: string
  notice?: string
  /** Shown to users without a phone number, who therefore get codes by e-mail. */
  phoneHint?: boolean
}

export const codePage = ({ uid, sentTo, error, notice, phoneHint }: CodePageOptions) =>
  page(
    'Enter your code',
    `<h1>Enter your code</h1>
<p>We sent a 6-digit code to ${escapeHtml(sentTo)}. It is valid for 10 minutes.</p>
${notice ? `<p role="status">${escapeHtml(notice)}</p>` : ''}
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/interaction/${encodeURIComponent(uid)}/code">
<label for="code">Code</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" required autofocus>
<label class="check"><input type="checkbox" name="remember"> Remember this device for 90 days, so I am not asked for a code here again</label>
<button type="submit">Continue</button>
</form>
<form method="post" action="/interaction/${encodeURIComponent(uid)}/code/resend">
<button type="submit" class="secondary">Send a new code</button>
</form>
<form method="post" action="/interaction/${encodeURIComponent(uid)}/abort">
<button type="submit" class="secondary">Cancel</button>
</form>
${phoneHint ? '<p><small>You get codes by e-mail because no mobile number is on file. Ask your administration to add yours if you would rather receive them by SMS.</small></p>' : ''}`,
  )

const passwordFields = (hint: string) => `<label for="password">New password</label>
<input id="password" name="password" type="password" autocomplete="new-password" minlength="10" maxlength="128" required>
<p><small>${escapeHtml(hint)}</small></p>
<label for="confirm">New password again</label>
<input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="10" maxlength="128" required>`

const PASSWORD_HINT = 'At least 10 characters. A few random words make a good password.'

export const activationPage = ({ token, error }: { token: string; error?: string }) =>
  page(
    'Choose your password',
    `<h1>Choose your password</h1>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/activate">
<input type="hidden" name="token" value="${escapeHtml(token)}">
${passwordFields(PASSWORD_HINT)}
<button type="submit">Activate my account</button>
</form>`,
  )

export const forgotPasswordPage = ({ email = '', error }: { email?: string; error?: string }) =>
  page(
    'Forgot your password?',
    `<h1>Forgot your password?</h1>
<p>Enter your e-mail address and we send you a code to choose a new password.</p>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/reset">
<label for="email">E-mail</label>
<input id="email" name="email" type="email" autocomplete="username" required autofocus value="${escapeHtml(email)}">
<button type="submit">Send the code</button>
</form>`,
  )

export const resetCodePage = ({ email, notice, error }: { email: string; notice?: string; error?: string }) =>
  page(
    'Choose a new password',
    `<h1>Choose a new password</h1>
${notice ? `<p role="status">${escapeHtml(notice)}</p>` : ''}
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/reset/code">
<input type="hidden" name="email" value="${escapeHtml(email)}">
<label for="code">Code</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" required autofocus>
${passwordFields(PASSWORD_HINT)}
<button type="submit">Change my password</button>
</form>
<p><a href="/reset?email=${encodeURIComponent(email)}">Send a new code</a></p>`,
  )
