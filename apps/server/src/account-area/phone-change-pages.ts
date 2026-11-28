import { changePhone, LifecycleError, type RequestContext } from '@progwise/pforte-db/admin'
import { CODE_LIFETIME_MS, CodeLimitError, currentCode, issueCode, withdrawCode } from '@progwise/pforte-db/codes'
import { parsePhone } from '@progwise/pforte-import'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { maskPhone } from '../auth/channels.js'
import { readCookie, setCookieHeader, sign, unsign } from '../interaction/signed-cookie.js'
import { NotifierUnavailableError } from '../notifications/notifier.js'
import { escapeHtml } from '../ui/pages.js'
import { tooManyRequests } from '../ui/too-many.js'
import { ACCOUNT_PATH } from './constants.js'
import { PHONE } from './phone-pages.js'
import type { AccountContext } from './routes.js'
import type { AccountUser } from './session.js'

export const PHONE_CHANGE = `${PHONE}/change`

const COOKIE = 'pforte_account_phone'

/** The number a code is on its way to, which code that is, for whom, and until when it can be entered. */
interface NewNumber {
  userId: string
  phone: string
  codeId: string
  expiresAt: number
}

/**
 * A person gives their account another mobile number, or its first one. It is the one detail of the overview
 * that is theirs to change: the phone is in their hand, and only they know when they got a new one.
 *
 * Two steps. They type the number and pforte sends a code to it by SMS; they enter the code and the number is
 * theirs, confirmed at once, since the code is the confirmation. Until the code is entered nothing has changed:
 * the number they had is stored and gets their codes. So a mistyped number costs a message and nothing else.
 *
 * Sending the code needs a recent sign-in, as every change here does. This one matters more than most: whoever
 * gets a number of their own into an account gets its codes from then on. Entering the code does not ask again,
 * as on the page that confirms a number, and for the same reasons. The person is told of the change by mail, at
 * the address the number cannot reach.
 *
 * The number that waits for its code is not stored with the person. It is in a signed cookie of this browser,
 * which lasts as long as the code does, and the code itself is bound to the number it was sent to
 * (`changePhone`): it makes that number the person's and no other, whatever the cookie says.
 *
 * The cookie names the code as well. A person has one code for this at a time, and asking for one in a second
 * browser ends the one the first browser waits for. The first browser then has nothing to enter any more: its
 * page asks for the number again, and a code typed into a form that was still open is not counted against the
 * code of the other browser.
 *
 * Only where this pforte sends SMS: a number is for codes, and without SMS it could never be confirmed.
 */
export const registerPhoneChangePages = (app: FastifyInstance, ctx: AccountContext) => {
  const { db, issuer, cookieKeys, gate, viewFor, page, redirectWith, requireRecentSignIn, notifier, codeSecrets, limiter, audit, background } = ctx

  const secure = issuer.startsWith('https:')
  const where = (request: FastifyRequest) => ({ ip: request.ip, userAgent: request.headers['user-agent'] })
  const selfContext = (request: FastifyRequest, user: AccountUser): RequestContext => ({ actor: { type: 'user', id: user.id }, ...where(request), self: true })

  const cookie = (value: string, maxAgeSeconds: number) => setCookieHeader(COOKIE, value, { path: PHONE_CHANGE, maxAgeSeconds, secure, sameSite: 'Lax' })
  const remember = (reply: FastifyReply, user: AccountUser, phone: string, issued: { id: string; expiresAt: Date }) =>
    reply.header(
      'Set-Cookie',
      cookie(sign(cookieKeys, { userId: user.id, phone, codeId: issued.id, expiresAt: issued.expiresAt.getTime() } satisfies NewNumber), Math.ceil(CODE_LIFETIME_MS / 1000)),
    )
  const forget = (reply: FastifyReply) => reply.header('Set-Cookie', cookie('', 0))
  /** The number this person asked for in this browser and the code that went to it, while the code can still be entered. */
  const newNumberOf = (request: FastifyRequest, user: AccountUser) => {
    const asked = unsign<NewNumber>(cookieKeys, readCookie(request.headers.cookie, COOKIE))
    const complete = asked && asked.userId === user.id && typeof asked.phone === 'string' && typeof asked.codeId === 'string' && asked.expiresAt > Date.now()
    return complete ? { phone: asked.phone, codeId: asked.codeId } : undefined
  }

  app.get<{ Querystring: { other?: string } }>(PHONE_CHANGE, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user, session } = signedIn
    if (!notifier.smsAvailable) return reply.redirect(ACCOUNT_PATH, 303)
    const { t } = viewFor(request, user)

    // As on the page that confirms a number, the page says what is true: a field for the code only while the code
    // that went to the number of this browser can still be entered. Not for a code another browser asked for
    // since: that one went elsewhere, and the one sent here is over.
    const asked = request.query.other === '1' ? undefined : newNumberOf(request, user)
    const current = asked && (await currentCode(db, { userId: user.id, purpose: 'phone_change' }))
    const waiting = asked !== undefined && current?.id === asked.codeId && current.usable
    // The number is typed after the new sign-in, not before it: what was typed would be lost on the way.
    if (!waiting && !requireRecentSignIn(reply, session, PHONE_CHANGE)) return reply

    const content = `<h1>${escapeHtml(t('account.phoneChange.title'))}</h1>
<div class="panel">
${
  waiting
    ? `<p>${escapeHtml(t('account.phoneChange.sent', { to: asked.phone }))}</p>
<form method="post" action="${PHONE_CHANGE}/confirm">
<label for="code">${escapeHtml(t('common.code'))}</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" required autofocus>
<button type="submit">${escapeHtml(t('account.phoneChange.confirm'))}</button>
</form>
<div class="actions">
<form method="post" action="${PHONE_CHANGE}/send"><input type="hidden" name="phone" value="${escapeHtml(asked.phone)}"><button type="submit" class="secondary">${escapeHtml(t('common.sendNewCode'))}</button></form>
<a class="button secondary" href="${PHONE_CHANGE}?other=1">${escapeHtml(t('account.phoneChange.other'))}</a>
</div>`
    : `<p>${escapeHtml(t('account.phoneChange.help'))}</p>
<form method="post" action="${PHONE_CHANGE}/send">
<label for="phone">${escapeHtml(t('account.phoneChange.number'))}</label>
<input id="phone" name="phone" type="tel" autocomplete="tel" maxlength="40" required autofocus>
<div class="actions">
<button type="submit">${escapeHtml(t('account.phoneChange.send'))}</button>
<a class="button secondary" href="${ACCOUNT_PATH}">${escapeHtml(t('common.cancel'))}</a>
</div>
</form>`
}
</div>`
    return reply.type('text/html').send(page(request, reply, user, 'start', t('account.phoneChange.title'), content))
  })

  app.post<{ Body: Record<string, unknown> }>(`${PHONE_CHANGE}/send`, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user, session } = signedIn
    if (!requireRecentSignIn(reply, session, PHONE_CHANGE)) return reply
    if (!notifier.smsAvailable) return reply.redirect(ACCOUNT_PATH, 303)

    const phone = parsePhone(typeof request.body?.phone === 'string' ? request.body.phone : '')
    if (!phone) return redirectWith(reply, `${PHONE_CHANGE}?other=1`, { kind: 'error', key: 'account.phoneChange.invalid' })
    // A number that is stored but not confirmed may be asked for: the code confirms it, and it is the person's then.
    if (phone === user.phone && user.phoneVerifiedAt) return redirectWith(reply, `${PHONE_CHANGE}?other=1`, { kind: 'error', key: 'account.phoneChange.same' })

    const wait = await limiter.codeResend(request.ip)
    if (wait > 0) {
      await audit.blocked(where(request), { scope: 'phone_code' })
      return tooManyRequests(reply, viewFor(request, user).view, wait)
    }
    try {
      // Bound to the number it goes to: it makes that number the person's and no other.
      const issued = await issueCode(db, { userId: user.id, channel: 'sms', purpose: 'phone_change', boundTo: phone }, { secrets: codeSecrets })
      await notifier.sendPhoneCode({ ...user, phone }, { code: issued.code, expiresAt: issued.expiresAt })
      await audit.codeSent(where(request), { userId: user.id, purpose: 'phone_change', channel: 'sms' })
      remember(reply, user, phone, issued)
    } catch (error) {
      // A code for this number or another was sent a moment ago, and the page still asks for that one.
      if (error instanceof CodeLimitError) return redirectWith(reply, PHONE_CHANGE, { kind: 'error', key: 'phone.wait', values: { seconds: error.retryAfterSeconds } })
      if (!(error instanceof NotifierUnavailableError)) throw error
      request.log.error(error, 'the code for a new phone number could not be sent')
      // Nobody is waiting for that code: the page asks for the number again instead of for the code.
      await withdrawCode(db, { userId: user.id, purpose: 'phone_change' })
      return redirectWith(reply, PHONE_CHANGE, { kind: 'error', key: 'account.phone.unavailable' })
    }
    return redirectWith(reply, PHONE_CHANGE, { kind: 'ok', key: 'code.newOnItsWay' })
  })

  app.post<{ Body: Record<string, unknown> }>(`${PHONE_CHANGE}/confirm`, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user } = signedIn
    if (!notifier.smsAvailable) return reply.redirect(ACCOUNT_PATH, 303)

    const wait = await limiter.codeBlockedFor(request.ip)
    if (wait > 0) {
      await audit.blocked(where(request), { scope: 'phone_code' })
      return tooManyRequests(reply, viewFor(request, user).view, wait)
    }
    const refused = async (reason: string) => {
      await limiter.codeFailed(request.ip)
      await audit.codeFailed(where(request), { userId: user.id, purpose: 'phone_change', reason })
      return redirectWith(reply, PHONE_CHANGE, { kind: 'error', key: 'code.badOrExpired' })
    }
    // The cookie lasts as long as the code: without it there is no code that could still be entered, and nothing
    // is checked.
    const asked = newNumberOf(request, user)
    if (!asked) return redirectWith(reply, PHONE_CHANGE, { kind: 'error', key: 'code.badOrExpired' })
    const { phone, codeId } = asked

    const code = typeof request.body?.code === 'string' ? request.body.code : ''
    const result = await changePhone(db, selfContext(request, user), { userId: user.id, phone, code, codeId }, { secrets: codeSecrets }).catch((error: unknown) => {
      // The person was locked meanwhile.
      if (error instanceof LifecycleError) return 'nothing' as const
      throw error
    })
    if (result === 'nothing') return reply.redirect(ACCOUNT_PATH, 303)
    if (!result?.ok) return refused(result?.reason ?? 'none')

    forget(reply)
    // The rightful person learns of a number that somebody else put in. Not tied to the response: a mail server
    // that is down must not turn a number that was changed into an error.
    background.run(async () => {
      try {
        await notifier.sendPhoneChanged(result.user, { phone: maskPhone(phone), url: `${issuer}${ACCOUNT_PATH}` })
      } catch (error) {
        if (error instanceof NotifierUnavailableError) request.log.error(error, 'the notice that the phone number was changed could not be sent')
        else throw error
      }
    })
    return redirectWith(reply, ACCOUNT_PATH, { kind: 'ok', key: 'account.phoneChange.done' })
  })
}
