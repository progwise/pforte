import { createHash } from 'node:crypto'

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
  .error { margin-bottom: 1rem; padding: 0.6rem; color: #82071e; background: #ffebe9; border-radius: 0.3rem; }
`

/** Content-Security-Policy for the pages below: no scripts, and only this exact stylesheet. */
export const contentSecurityPolicy = [
  "default-src 'none'",
  `style-src 'sha256-${createHash('sha256').update(css).digest('base64')}'`,
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ')

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
