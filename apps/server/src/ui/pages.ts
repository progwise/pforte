import type { FastifyInstance } from 'fastify'
import type { I18n, MessageKey, Values } from '../i18n/index.js'
import { buildContentSecurityPolicy, buildCss, defaultTheme, type FooterLink, type Theme } from './theme.js'

const escapeMap: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => escapeMap[char] as string)

export interface PagesOptions {
  /** Whether "Remember this device" is ticked when the code page opens. */
  rememberDeviceDefault?: boolean
  /** The look of the pages. The neutral one if not given. */
  theme?: Theme
}

/** The pages of one language. */
export interface PageSet {
  language: string
  /** A text in this language, for the parts of a page that routes fill in themselves. */
  t(key: MessageKey, values?: Values): string
  login(options: { uid: string; clientName?: string; email?: string; error?: string }): string
  code(options: {
    uid: string
    channel: 'email' | 'sms'
    /** Where the code went, already masked. */
    sentTo: string
    /** Offer to send the code by e-mail instead of SMS. */
    canUseEmail?: boolean
    error?: string
    notice?: string
    /** Shown to users without a phone number, who therefore get codes by e-mail. */
    phoneHint?: boolean
  }): string
  activation(options: { token: string; error?: string }): string
  forgotPassword(options: { email?: string; error?: string }): string
  resetCode(options: { email: string; notice?: string; error?: string }): string
  phoneConfirm(options: { sentTo: string; error?: string; notice?: string }): string
  /** A page that only says something: a title and a text, both already in the right language. */
  notice(title: string, message: string): string
}

export interface Pages {
  for(language: string): PageSet
  /** Headers for every page with a form: nothing is cached or sent along as referrer, and only our own styles, fonts and logo load. */
  addHeaders(app: FastifyInstance): void
}

/** The text of a footer link in a language; `en` is the fallback for languages the link does not list. */
const labelOf = (link: FooterLink, language: string) =>
  typeof link.label === 'string' ? link.label : (link.label[language] ?? link.label[language.split('-')[0]!] ?? link.label.en ?? Object.values(link.label)[0]!)

export const createPages = (i18n: I18n, { rememberDeviceDefault = false, theme = defaultTheme() }: PagesOptions = {}): Pages => {
  const css = buildCss(theme)
  const contentSecurityPolicy = buildContentSecurityPolicy(css, theme)

  return {
  addHeaders(app) {
    app.addHook('onSend', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store')
      reply.header('Content-Security-Policy', contentSecurityPolicy)
      reply.header('X-Content-Type-Options', 'nosniff')
      reply.header('Referrer-Policy', 'no-referrer')
    })
  },
  for(requested) {
    const language = i18n.pick(requested)
    const t = (key: MessageKey, values?: Values) => i18n.text(language, key, values)

    const header = theme.logoUrl
      ? `<img class="logo" src="${escapeHtml(theme.logoUrl)}" alt="${escapeHtml(theme.name ?? '')}">\n`
      : theme.name
        ? `<p class="brand">${escapeHtml(theme.name)}</p>\n`
        : ''
    const footer = theme.links.length
      ? `<nav class="links">\n${theme.links.map((link) => `<a href="${escapeHtml(link.url)}">${escapeHtml(labelOf(link, language))}</a>`).join('\n')}\n</nav>\n`
      : ''

    const page = (title: string, body: string) => `<!doctype html>
<html lang="${escapeHtml(language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
</head>
<body>
<main>
${header}${body}
</main>
${footer}</body>
</html>`

    const alert = (error?: string) => (error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '')
    const status = (notice?: string) => (notice ? `<p role="status">${escapeHtml(notice)}</p>` : '')
    const codeField = `<label for="code">${escapeHtml(t('common.code'))}</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" required autofocus>`
    const passwordFields = `<label for="password">${escapeHtml(t('password.new'))}</label>
<input id="password" name="password" type="password" autocomplete="new-password" minlength="10" maxlength="128" required>
<p><small>${escapeHtml(t('password.hint'))}</small></p>
<label for="confirm">${escapeHtml(t('password.confirm'))}</label>
<input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="10" maxlength="128" required>`
    const hiddenLanguage = `<input type="hidden" name="lang" value="${escapeHtml(language)}">`

    return {
      language,
      t,

      login: ({ uid, clientName, email = '', error }) =>
        page(
          t('login.title'),
          `<h1>${escapeHtml(clientName ? t('login.titleTo', { client: clientName }) : t('login.title'))}</h1>
${alert(error)}
<form method="post" action="/interaction/${encodeURIComponent(uid)}/login">
<label for="email">${escapeHtml(t('common.email'))}</label>
<input id="email" name="email" type="email" autocomplete="username" required autofocus value="${escapeHtml(email)}">
<label for="password">${escapeHtml(t('login.password'))}</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">${escapeHtml(t('login.submit'))}</button>
</form>
<p><a href="/reset?lang=${encodeURIComponent(language)}">${escapeHtml(t('login.forgot'))}</a></p>
<form method="post" action="/interaction/${encodeURIComponent(uid)}/abort">
<button type="submit" class="secondary">${escapeHtml(t('common.cancel'))}</button>
</form>`,
        ),

      code: ({ uid, channel, sentTo, canUseEmail, error, notice, phoneHint }) =>
        page(
          t('code.title'),
          `<h1>${escapeHtml(t('code.title'))}</h1>
<p>${escapeHtml(t(channel === 'sms' ? 'code.sentSms' : 'code.sentEmail', { to: sentTo }))}</p>
${status(notice)}
${alert(error)}
<form method="post" action="/interaction/${encodeURIComponent(uid)}/code">
${codeField}
<label class="check"><input type="checkbox" name="remember"${rememberDeviceDefault ? ' checked' : ''}> ${escapeHtml(t('code.remember'))}</label>
<button type="submit">${escapeHtml(t('code.submit'))}</button>
</form>
<form method="post" action="/interaction/${encodeURIComponent(uid)}/code/resend">
<button type="submit" class="secondary">${escapeHtml(t('common.sendNewCode'))}</button>
</form>
${
  canUseEmail
    ? `<form method="post" action="/interaction/${encodeURIComponent(uid)}/code/resend">
<input type="hidden" name="channel" value="email">
<button type="submit" class="secondary">${escapeHtml(t('code.useEmail'))}</button>
</form>`
    : ''
}
<form method="post" action="/interaction/${encodeURIComponent(uid)}/abort">
<button type="submit" class="secondary">${escapeHtml(t('common.cancel'))}</button>
</form>
${phoneHint ? `<p><small>${escapeHtml(t('code.phoneHint'))}</small></p>` : ''}`,
        ),

      activation: ({ token, error }) =>
        page(
          t('activate.title'),
          `<h1>${escapeHtml(t('activate.title'))}</h1>
${alert(error)}
<form method="post" action="/activate">
<input type="hidden" name="token" value="${escapeHtml(token)}">
${passwordFields}
<button type="submit">${escapeHtml(t('activate.submit'))}</button>
</form>`,
        ),

      forgotPassword: ({ email = '', error }) =>
        page(
          t('reset.title'),
          `<h1>${escapeHtml(t('reset.title'))}</h1>
<p>${escapeHtml(t('reset.intro'))}</p>
${alert(error)}
<form method="post" action="/reset">
${hiddenLanguage}
<label for="email">${escapeHtml(t('common.email'))}</label>
<input id="email" name="email" type="email" autocomplete="username" required autofocus value="${escapeHtml(email)}">
<button type="submit">${escapeHtml(t('reset.send'))}</button>
</form>`,
        ),

      resetCode: ({ email, notice, error }) =>
        page(
          t('reset.codeTitle'),
          `<h1>${escapeHtml(t('reset.codeTitle'))}</h1>
${status(notice)}
${alert(error)}
<form method="post" action="/reset/code">
${hiddenLanguage}
<input type="hidden" name="email" value="${escapeHtml(email)}">
${codeField}
${passwordFields}
<button type="submit">${escapeHtml(t('reset.codeSubmit'))}</button>
</form>
<p><a href="/reset?email=${encodeURIComponent(email)}&amp;lang=${encodeURIComponent(language)}">${escapeHtml(t('common.sendNewCode'))}</a></p>`,
        ),

      phoneConfirm: ({ sentTo, error, notice }) =>
        page(
          t('phone.title'),
          `<h1>${escapeHtml(t('phone.title'))}</h1>
<p>${escapeHtml(t('phone.intro', { to: sentTo }))}</p>
${status(notice)}
${alert(error)}
<form method="post" action="/activate/phone">
${codeField}
<button type="submit">${escapeHtml(t('phone.confirm'))}</button>
</form>
<form method="post" action="/activate/phone/resend">
<button type="submit" class="secondary">${escapeHtml(t('common.sendNewCode'))}</button>
</form>
<form method="post" action="/activate/phone/skip">
<button type="submit" class="secondary">${escapeHtml(t('phone.skip'))}</button>
</form>`,
        ),

      notice: (title, message) => page(title, `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>`),
    }
  },
  }
}
