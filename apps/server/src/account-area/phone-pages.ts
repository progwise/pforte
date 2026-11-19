import { confirmPhone, LifecycleError, type RequestContext } from '@progwise/pforte-db/admin'
import { CodeLimitError, currentCode, issueCode, withdrawCode } from '@progwise/pforte-db/codes'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { canConfirmPhone, maskPhone } from '../auth/channels.js'
import { shortWaitValues } from '../i18n/duration.js'
import { NotifierUnavailableError } from '../notifications/notifier.js'
import { escapeHtml } from '../ui/pages.js'
import { tooManyRequests } from '../ui/too-many.js'
import { ACCOUNT_PATH } from './constants.js'
import type { AccountContext } from './routes.js'
import type { AccountUser } from './session.js'

export const PHONE = `${ACCOUNT_PATH}/phone`

/**
 * Confirming the phone number, for a person who could not do it when they chose their first password: they
 * skipped the step, had no number then, or the back office has changed it since. The number itself is the
 * organisation's and is not changed here; the person only shows that they hold the phone.
 *
 * It is the step of the activation, with the same codes and limits. Sending the code needs a recent sign-in, as
 * every change here does, and it is what costs a message. Entering it does not ask again: the code is newer proof
 * than the sign-in, it runs out by itself, and asking could turn away a person who waited for the SMS.
 *
 * The code is bound to the number it was sent to and confirms that number only (`confirmPhone`), whatever the back
 * office changes while it is on its way.
 */
export const registerPhonePages = (app: FastifyInstance, ctx: AccountContext) => {
  const { db, gate, viewFor, page, redirectWith, requireRecentSignIn, notifier, codeSecrets, limiter, audit } = ctx

  const where = (request: FastifyRequest) => ({ ip: request.ip, userAgent: request.headers['user-agent'] })
  const selfContext = (request: FastifyRequest, user: AccountUser): RequestContext => ({ actor: { type: 'user', id: user.id }, ...where(request), self: true })

  app.get(PHONE, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user } = signedIn
    if (!canConfirmPhone(user, notifier)) return reply.redirect(ACCOUNT_PATH, 303)
    const { t } = viewFor(request, user)

    // The page says what is true: a field for the code only while there is one that can still be entered.
    // Somebody who had to sign in again before the first code, whose code could not be sent or has no attempts
    // left, is offered to send one, and so is somebody whose number the back office changed: that ends the code
    // that was out (`updateUser`). With the field the page names no number: a code that was issued for the old
    // number in the moment of the change is still out, and went there. It is refused, and the next one goes to
    // the number that is stored.
    const waiting = (await currentCode(db, { userId: user.id, purpose: 'activation' }))?.usable === true
    const content = `<h1>${escapeHtml(t('phone.title'))}</h1>
<div class="panel">
${
  waiting
    ? `<p>${escapeHtml(t('account.phone.intro'))}</p>
<form method="post" action="${PHONE}/confirm">
<label for="code">${escapeHtml(t('common.code'))}</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" required autofocus>
<button type="submit">${escapeHtml(t('phone.confirm'))}</button>
</form>
<form method="post" action="${PHONE}/send"><button type="submit" class="secondary">${escapeHtml(t('common.sendNewCode'))}</button></form>`
    : `<p>${escapeHtml(t('account.phone.introSend', { to: maskPhone(user.phone) }))}</p>
<form method="post" action="${PHONE}/send"><button type="submit">${escapeHtml(t('account.phone.send'))}</button></form>`
}
</div>`
    return reply.type('text/html').send(page(request, reply, user, 'start', t('phone.title'), content))
  })

  app.post(`${PHONE}/send`, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user, session } = signedIn
    if (!requireRecentSignIn(reply, session, PHONE)) return reply
    if (!canConfirmPhone(user, notifier)) return reply.redirect(ACCOUNT_PATH, 303)

    const wait = await limiter.codeResend(request.ip)
    if (wait > 0) {
      await audit.blocked(where(request), { scope: 'phone_code' })
      return tooManyRequests(reply, viewFor(request, user).view, wait)
    }
    try {
      // Bound to the number it goes to, the one this request read: it confirms that number and no other.
      const { code, expiresAt } = await issueCode(db, { userId: user.id, channel: 'sms', purpose: 'activation', boundTo: user.phone }, { secrets: codeSecrets })
      await notifier.sendPhoneCode(user, { code, expiresAt })
      await audit.codeSent(where(request), { userId: user.id, purpose: 'activation', channel: 'sms' })
    } catch (error) {
      // Worded here, in the language the next page is shown in: a time in words cannot travel as a value of the message.
      if (error instanceof CodeLimitError) return redirectWith(reply, PHONE, { kind: 'error', text: viewFor(request, user).t('phone.wait', shortWaitValues(error.retryAfterSeconds)) })
      if (!(error instanceof NotifierUnavailableError)) throw error
      request.log.error(error, 'the code to confirm the phone number could not be sent')
      // Nobody is waiting for that code: the page offers to send one again instead of asking for it.
      await withdrawCode(db, { userId: user.id, purpose: 'activation' })
      return redirectWith(reply, PHONE, { kind: 'error', key: 'account.phone.unavailable' })
    }
    return redirectWith(reply, PHONE, { kind: 'ok', key: 'code.newOnItsWay' })
  })

  app.post<{ Body: Record<string, unknown> }>(`${PHONE}/confirm`, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user } = signedIn
    if (!canConfirmPhone(user, notifier)) return reply.redirect(ACCOUNT_PATH, 303)

    const wait = await limiter.codeBlockedFor(request.ip)
    if (wait > 0) {
      await audit.blocked(where(request), { scope: 'phone_code' })
      return tooManyRequests(reply, viewFor(request, user).view, wait)
    }
    const code = typeof request.body?.code === 'string' ? request.body.code : ''
    // The check of the code and the confirmation are one step, for the person as they are at that moment.
    const result = await confirmPhone(db, selfContext(request, user), { userId: user.id, code }, { secrets: codeSecrets }).catch((error: unknown) => {
      // Nothing to confirm any more: confirmed in another window, or the person was locked meanwhile.
      if (error instanceof LifecycleError) return 'nothing' as const
      throw error
    })
    if (result === 'nothing') return reply.redirect(ACCOUNT_PATH, 303)
    if (!result?.ok) {
      await limiter.codeFailed(request.ip)
      await audit.codeFailed(where(request), { userId: user.id, purpose: 'activation', reason: result?.reason ?? 'none' })
      return redirectWith(reply, PHONE, { kind: 'error', key: 'code.badOrExpired' })
    }
    return redirectWith(reply, ACCOUNT_PATH, { kind: 'ok', key: 'phone.doneTitle' })
  })
}
