import { CODE_LIFETIME_MS } from '@progwise/pforte-db/codes'
import type { FastifyInstance } from 'fastify'
import { validity } from '../i18n/duration.js'
import type { I18n, MessageKey, TextValues } from '../i18n/index.js'
import { buildContentSecurityPolicy, buildCss, defaultTheme, type FooterLink, type Theme } from './theme.js'

const escapeMap: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => escapeMap[char] as string)

export interface PagesOptions {
  /** Whether "Remember this device" is ticked when the code page or the activation page opens. */
  rememberDeviceDefault?: boolean
  /** The look of the pages. The neutral one if not given. */
  theme?: Theme
}

/** A hidden field that says whether the device can make a passkey, and the script that fills it in. */
export interface PasskeyProbe {
  field: string
  script: string
}

/** The pages of one language. */
export interface PageSet {
  language: string
  /** A text in this language, for the parts of a page that routes fill in themselves. */
  t(key: MessageKey, values?: TextValues): string
  login(options: {
    uid: string
    clientName?: string
    /** Carried to the page for a forgotten password. */
    clientId?: string
    email?: string
    error?: string
    /** Lets a person sign in with a passkey: the attributes of the form that asks the device, and the script. */
    passkey?: { attributes: string; script: string }
  }): string
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
    /** Finds out whether this device can make a passkey: a hidden field of the form, and the script that fills it. */
    passkeyProbe?: PasskeyProbe
  }): string
  /**
   * `email` is whose password is being chosen, shown so that a password manager saves it under that address.
   * `remember` is the box as the person left it, when the page is shown again; without it the configured default.
   */
  activation(options: { token: string; email: string; error?: string; remember?: boolean; passkeyProbe?: PasskeyProbe }): string
  /**
   * Offers to make a passkey, to somebody who has just shown who they are: after a sign-in with a code, after an
   * activation. `action` takes the device's answer, `skipAction` is "not now".
   */
  passkeyOffer(options: { action: string; skipAction: string; /** The attributes of the form that asks the device. */ attributes: string; script: string; error?: string }): string
  /** `clientId` is the application the person came from, so the last page of the reset can lead back to it. */
  forgotPassword(options: { email?: string; error?: string; clientId?: string }): string
  resetCode(options: { email: string; notice?: string; error?: string; clientId?: string }): string
  phoneConfirm(options: { sentTo: string; error?: string; notice?: string }): string
  /**
   * Asks somebody who has just signed in to confirm their phone number, before they go back to the application.
   * `action` is where the step lives: its forms post to `/send`, `/confirm` and `/skip` below it. With `codeSent`
   * there is a code to enter; without, the page offers to send one to `sentTo`.
   */
  phoneStep(options: { action: string; sentTo: string; codeSent: boolean; error?: string; notice?: string }): string
  /** A page that only says something: a title and a text, both already in the right language, and perhaps a button. */
  notice(title: string, message: string, action?: { href: string; label: string }): string
  /**
   * Asks whether to sign out (OpenID Connect RP-initiated logout). `formHtml` is the form the library made, with its
   * protection against forgery; the buttons belong to it. `clientName` is the application that sent the person here:
   * it has ended its own session and loses its tokens whatever the answer is, so with it the question is whether to
   * end the sign-in at pforte as well, and a "no" must not promise that the person stays signed in there.
   */
  logoutConfirm(options: { host: string; formHtml: string; clientName?: string }): string
  /**
   * A page of one of pforte's own areas (the administration, the account pages): a bar with the sections and the
   * person, a message from the last action, and the content, which is HTML the caller has already escaped.
   * The sections are on the page twice, and the stylesheet shows one of the two: the row of a wide screen, or for a
   * phone a menu that opens (`<details>`, so without script) and is one line high while it is closed.
   */
  manage(options: {
    title: string
    nav: { href: string; label: string; current?: boolean }[]
    /** `signOutAction` is where the button posts to; the administration's, unless the area says otherwise. */
    person?: { signedInAs: string; signOutLabel: string; signOutAction?: string }
    flash?: { kind: 'ok' | 'error'; text: string }
    sectionsLabel: string
    content: string
  }): string
}

export interface Pages {
  /** The policy of the pages, for the pages that the OpenID library renders and pforte supplies the text of. */
  readonly contentSecurityPolicy: string
  for(language: string): PageSet
  /** Headers for every page with a form: nothing is cached or sent along as referrer, and only our own styles, fonts, logo and icon load. */
  addHeaders(app: FastifyInstance): void
}

/** The text of a footer link in a language; `en` is the fallback for languages the link does not list. */
const labelOf = (link: FooterLink, language: string) =>
  typeof link.label === 'string' ? link.label : (link.label[language] ?? link.label[language.split('-')[0]!] ?? link.label.en ?? Object.values(link.label)[0]!)

export const createPages = (i18n: I18n, { rememberDeviceDefault = false, theme = defaultTheme() }: PagesOptions = {}): Pages => {
  const css = buildCss(theme)
  const contentSecurityPolicy = buildContentSecurityPolicy(css, theme)

  return {
  contentSecurityPolicy,
  addHeaders(app) {
    app.addHook('onSend', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store')
      // A page that runs the passkey script has said so itself (see `PasskeyScript.allow`); every other gets the policy without script.
      if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', contentSecurityPolicy)
      reply.header('X-Content-Type-Options', 'nosniff')
      reply.header('Referrer-Policy', 'no-referrer')
    })
  },
  for(requested) {
    const language = i18n.pick(requested)
    const t = (key: MessageKey, values?: TextValues) => i18n.text(language, key, values)

    const header = theme.logoUrl
      ? `<img class="logo" src="${escapeHtml(theme.logoUrl)}" alt="${escapeHtml(theme.name ?? '')}">\n`
      : theme.name
        ? `<p class="brand">${escapeHtml(theme.name)}</p>\n`
        : ''
    const icon = theme.iconUrl ? `<link rel="icon" href="${escapeHtml(theme.iconUrl)}">\n` : ''
    const footer = theme.links.length
      ? `<nav class="links">\n${theme.links.map((link) => `<a href="${escapeHtml(link.url)}">${escapeHtml(labelOf(link, language))}</a>`).join('\n')}\n</nav>\n`
      : ''

    const page = (title: string, body: string) => `<!doctype html>
<html lang="${escapeHtml(language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${icon}<style>${css}</style>
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
    /**
     * The address a new password belongs to, directly above the fields for it. A password manager saves a password
     * under the nearest field in front of it that it takes for a user name: without this one that is the code of a
     * reset, or nothing. It has to be visible, a hidden field is not read. It cannot be changed where the address is
     * known; a page opened without one asks for it.
     */
    const accountField = (email: string) => `<label for="email">${escapeHtml(t('common.email'))}</label>
<input id="email" name="email" type="email" autocomplete="username" required ${email ? 'readonly ' : ''}value="${escapeHtml(email)}">`
    const hiddenLanguage = `<input type="hidden" name="lang" value="${escapeHtml(language)}">`
    const hiddenClient = (clientId?: string) => (clientId ? `<input type="hidden" name="client_id" value="${escapeHtml(clientId)}">` : '')
    const clientQuery = (clientId?: string) => (clientId ? `&amp;client_id=${encodeURIComponent(clientId)}` : '')

    return {
      language,
      t,

      login: ({ uid, clientName, clientId, email = '', error, passkey }) =>
        page(
          t('login.title'),
          `<h1>${escapeHtml(clientName ? t('login.titleTo', { client: clientName }) : t('login.title'))}</h1>
${alert(error)}
<form method="post" action="/interaction/${encodeURIComponent(uid)}/login">
<label for="email">${escapeHtml(t('common.email'))}</label>
<input id="email" name="email" type="email" autocomplete="${passkey ? 'username webauthn' : 'username'}" required autofocus value="${escapeHtml(email)}">
<label for="password">${escapeHtml(t('login.password'))}</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">${escapeHtml(t('login.submit'))}</button>
</form>
<p class="aside"><a href="/reset?lang=${encodeURIComponent(language)}${clientQuery(clientId)}">${escapeHtml(t('login.forgot'))}</a></p>
${
  // Hidden until the script finds that this browser knows passkeys: without it the page is the one above and below.
  passkey
    ? `<form method="post" action="/interaction/${encodeURIComponent(uid)}/passkey" ${passkey.attributes}>
<input type="hidden" name="credential">
<p class="error" role="alert" data-passkey-message="failed" hidden>${escapeHtml(t('login.passkeyCancelled'))}</p>
<button type="submit" class="secondary">${escapeHtml(t('login.passkey'))}</button>
</form>`
    : ''
}
<form method="post" action="/interaction/${encodeURIComponent(uid)}/abort">
<button type="submit" class="secondary">${escapeHtml(t('common.cancel'))}</button>
</form>${passkey ? `\n${passkey.script}` : ''}`,
        ),

      code: ({ uid, channel, sentTo, canUseEmail, error, notice, phoneHint, passkeyProbe }) =>
        page(
          t('code.title'),
          `<h1>${escapeHtml(t('code.title'))}</h1>
<p>${escapeHtml(t(channel === 'sms' ? 'code.sentSms' : 'code.sentEmail', { to: sentTo, validity: validity(CODE_LIFETIME_MS) }))}</p>
${status(notice)}
${alert(error)}
<form method="post" action="/interaction/${encodeURIComponent(uid)}/code">
${codeField}${passkeyProbe ? `\n${passkeyProbe.field}` : ''}
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
${phoneHint ? `<p><small>${escapeHtml(t('code.phoneHint'))}</small></p>` : ''}${passkeyProbe ? `\n${passkeyProbe.script}` : ''}`,
        ),

      activation: ({ token, email, error, remember = rememberDeviceDefault, passkeyProbe }) =>
        page(
          t('activate.title'),
          `<h1>${escapeHtml(t('activate.title'))}</h1>
${alert(error)}
<form method="post" action="/activate">
<input type="hidden" name="token" value="${escapeHtml(token)}">${passkeyProbe ? `\n${passkeyProbe.field}` : ''}
${accountField(email)}
${passwordFields}
<label class="check"><input type="checkbox" name="remember"${remember ? ' checked' : ''}> ${escapeHtml(t('code.remember'))}</label>
<button type="submit">${escapeHtml(t('activate.submit'))}</button>
</form>${passkeyProbe ? `\n${passkeyProbe.script}` : ''}`,
        ),

      // The same messages as on the account page that makes a passkey; here the way on never depends on the device.
      passkeyOffer: ({ action, skipAction, attributes, script, error }) =>
        page(
          t('passkeyOffer.title'),
          `<h1>${escapeHtml(t('passkeyOffer.title'))}</h1>
<p>${escapeHtml(t('passkeyOffer.text'))}</p>
${alert(error)}
<form method="post" action="${escapeHtml(action)}" ${attributes}>
<input type="hidden" name="credential">
<p class="error" role="alert" data-passkey-message="unsupported">${escapeHtml(t('account.passkeys.new.unsupported'))}</p>
<p class="error" role="alert" data-passkey-message="failed" hidden>${escapeHtml(t('account.passkeys.new.failed'))}</p>
<p class="error" role="alert" data-passkey-message="exists" hidden>${escapeHtml(t('account.passkeys.new.exists'))}</p>
<button type="submit" disabled>${escapeHtml(t('account.passkeys.new.button'))}</button>
</form>
<form method="post" action="${escapeHtml(skipAction)}">
<button type="submit" class="secondary">${escapeHtml(t('passkeyOffer.skip'))}</button>
</form>
${script}`,
        ),

      forgotPassword: ({ email = '', error, clientId }) =>
        page(
          t('reset.title'),
          `<h1>${escapeHtml(t('reset.title'))}</h1>
<p>${escapeHtml(t('reset.intro'))}</p>
${alert(error)}
<form method="post" action="/reset">
${hiddenLanguage}
${hiddenClient(clientId)}
<label for="email">${escapeHtml(t('common.email'))}</label>
<input id="email" name="email" type="email" autocomplete="username" required autofocus value="${escapeHtml(email)}">
<button type="submit">${escapeHtml(t('reset.send'))}</button>
</form>`,
        ),

      resetCode: ({ email, notice, error, clientId }) =>
        page(
          t('reset.codeTitle'),
          `<h1>${escapeHtml(t('reset.codeTitle'))}</h1>
${status(notice)}
${alert(error)}
<form method="post" action="/reset/code">
${hiddenLanguage}
${hiddenClient(clientId)}
${codeField}
${accountField(email)}
${passwordFields}
<button type="submit">${escapeHtml(t('reset.codeSubmit'))}</button>
</form>
<p><a href="/reset?email=${encodeURIComponent(email)}&amp;lang=${encodeURIComponent(language)}${clientQuery(clientId)}">${escapeHtml(t('common.sendNewCode'))}</a></p>`,
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

      phoneStep: ({ action, sentTo, codeSent, error, notice }) =>
        page(
          t('phone.title'),
          `<h1>${escapeHtml(t('phone.title'))}</h1>
<p>${escapeHtml(codeSent ? t('account.phone.intro') : t('phone.signIn', { to: sentTo }))}</p>
${status(notice)}
${alert(error)}
${
  codeSent
    ? `<form method="post" action="${escapeHtml(action)}/confirm">
${codeField}
<button type="submit">${escapeHtml(t('phone.confirm'))}</button>
</form>
<form method="post" action="${escapeHtml(action)}/send">
<button type="submit" class="secondary">${escapeHtml(t('common.sendNewCode'))}</button>
</form>`
    : `<form method="post" action="${escapeHtml(action)}/send">
<button type="submit">${escapeHtml(t('account.phone.send'))}</button>
</form>`
}
<form method="post" action="${escapeHtml(action)}/skip">
<button type="submit" class="secondary">${escapeHtml(t('phone.later'))}</button>
</form>`,
        ),

      notice: (title, message, action) =>
        page(title, `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>${action ? `\n<p><a class="button" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a></p>` : ''}`),

      logoutConfirm: ({ host, formHtml, clientName }) => {
        const title = clientName ? t('logout.titleFrom') : t('logout.title')
        return page(
          title,
          `<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(clientName ? t('logout.textFrom', { client: clientName, host }) : t('logout.text', { host }))}</p>
${formHtml}
<button autofocus type="submit" form="op.logoutForm" name="logout" value="yes">${escapeHtml(t('logout.yes'))}</button>
<button type="submit" form="op.logoutForm" class="secondary">${escapeHtml(clientName ? t('logout.noFrom', { client: clientName }) : t('logout.no'))}</button>`,
        )
      },

      manage: ({ title, nav, person, flash, sectionsLabel, content }) => {
        const links = nav.map((item) => `<a href="${escapeHtml(item.href)}"${item.current ? ' aria-current="page"' : ''}>${escapeHtml(item.label)}</a>`).join('\n')
        // Twice in the page, as the sections are: beside them in the wide bar, and at the end of the menu that opens.
        const signOut = person ? `<form method="post" action="${escapeHtml(person.signOutAction ?? '/manage/logout')}"><button type="submit" class="secondary">${escapeHtml(person.signOutLabel)}</button></form>` : ''
        return `<!doctype html>
<html lang="${escapeHtml(language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}${theme.name ? ` · ${escapeHtml(theme.name)}` : ''}</title>
${icon}<style>${css}</style>
</head>
<body class="manage">
<header class="bar">
${theme.logoUrl ? `<img class="logo" src="${escapeHtml(theme.logoUrl)}" alt="${escapeHtml(theme.name ?? '')}">` : theme.name ? `<span class="brand">${escapeHtml(theme.name)}</span>` : ''}
<nav class="sections" aria-label="${escapeHtml(sectionsLabel)}">
${links}
</nav>
<details class="menu">
<summary><span>${escapeHtml(nav.find((item) => item.current)?.label ?? sectionsLabel)}</span></summary>
<nav aria-label="${escapeHtml(sectionsLabel)}">
${links}${person ? `\n<p>${escapeHtml(person.signedInAs)}</p>\n${signOut}` : ''}
</nav>
</details>
${person ? `<div class="who"><span>${escapeHtml(person.signedInAs)}</span>\n${signOut}</div>` : ''}
</header>
<main class="page" id="content">
${flash ? `<p class="flash ${flash.kind}" role="${flash.kind === 'error' ? 'alert' : 'status'}">${escapeHtml(flash.text)}</p>` : ''}
${content}
</main>
${footer}</body>
</html>`
      },
    }
  },
  }
}
