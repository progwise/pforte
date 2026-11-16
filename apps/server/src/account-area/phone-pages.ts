import { confirmPhone, type RequestContext } from '@progwise/pforte-db/admin'
import { checkCode, CodeLimitError, issueCode } from '@progwise/pforte-db/codes'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { maskPhone } from '../auth/channels.js'
import { NotifierUnavailableError } from '../notifications/notifier.js'
import { escapeHtml } from '../ui/pages.js'
import { tooManyRequests } from '../ui/too-many.js'
import { ACCOUNT_PATH } from './constants.js'
import type { AccountContext } from './routes.js'
import type { AccountUser } from './session.js'

export const PHONE = `${ACCOUNT_PATH}/phone`

/**
 * Whether the person has a phone number that codes could go to, if only it were confirmed. Without SMS in this
 * installation there is nothing to confirm a number for.
 */
export const canConfirmPhone = (ctx: Pick<AccountContext, 'notifier'>, user: AccountUser): user is AccountUser & { phone: string } =>
  ctx.notifier.smsAvailable && Boolean(user.phone) && !user.phoneVerifiedAt

/**
 * Confirming the phone number, for a person who could not do it when they chose their first password: they
 * skipped the step, had no number then, or the back office has changed it since. The number itself is the
 * organisation's and is not changed here; the person only shows that they hold the phone.
 *
 * It is the step of the activation, with the same codes and limits. Sending the code needs a recent sign-in, as
 * every change here does, and it is what costs a message. Entering it does not ask again: the code is newer proof
 * than the sign-in, it runs out by itself, and asking could turn away a person who waited for the SMS.
 */
export const registerPhonePages = (app: FastifyInstance, ctx: AccountContext) => {
  const { db, gate, viewFor, page, redirectWith, requireRecentSignIn, notifier, codeSecrets, limiter, audit } = ctx

  const where = (request: FastifyRequest) => ({ ip: request.ip, userAgent: request.headers['user-agent'] })
  const selfContext = (request: FastifyRequest, user: AccountUser): RequestContext => ({ actor: { type: 'user', id: user.id }, ...where(request), self: true })

  app.get(PHONE, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user } = signedIn
    if (!canConfirmPhone(ctx, user)) return reply.redirect(ACCOUNT_PATH, 303)
    const { t } = viewFor(request, user)

    const content = `<h1>${escapeHtml(t('phone.title'))}</h1>
<div class="panel">
<p>${escapeHtml(t('account.phone.intro', { to: maskPhone(user.phone) }))}</p>
<form method="post" action="${PHONE}/confirm">
<label for="code">${escapeHtml(t('common.code'))}</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" required autofocus>
<button type="submit">${escapeHtml(t('phone.confirm'))}</button>
</form>
<form method="post" action="${PHONE}/send"><button type="submit" class="secondary">${escapeHtml(t('common.sendNewCode'))}</button></form>
</div>`
    return reply.type('text/html').send(page(request, reply, user, 'start', t('phone.title'), content))
  })

  app.post(`${PHONE}/send`, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user, session } = signedIn
    if (!requireRecentSignIn(reply, session, PHONE)) return reply
    if (!canConfirmPhone(ctx, user)) return reply.redirect(ACCOUNT_PATH, 303)

    const wait = await limiter.codeResend(request.ip)
    if (wait > 0) {
      await audit.blocked(where(request), { scope: 'phone_code' })
      return tooManyRequests(reply, viewFor(request, user).view, wait)
    }
    try {
      const { code, expiresAt } = await issueCode(db, { userId: user.id, channel: 'sms', purpose: 'activation' }, { secrets: codeSecrets })
      await notifier.sendPhoneCode(user, { code, expiresAt })
      await audit.codeSent(where(request), { userId: user.id, purpose: 'activation', channel: 'sms' })
    } catch (error) {
      if (error instanceof CodeLimitError) return redirectWith(reply, PHONE, { kind: 'error', key: 'phone.wait', values: { seconds: error.retryAfterSeconds } })
      if (!(error instanceof NotifierUnavailableError)) throw error
      request.log.error(error, 'the code to confirm the phone number could not be sent')
      return redirectWith(reply, PHONE, { kind: 'error', key: 'account.phone.unavailable' })
    }
    return redirectWith(reply, PHONE, { kind: 'ok', key: 'code.newOnItsWay' })
  })

  app.post<{ Body: Record<string, unknown> }>(`${PHONE}/confirm`, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user } = signedIn
    if (!canConfirmPhone(ctx, user)) return reply.redirect(ACCOUNT_PATH, 303)

    const wait = await limiter.codeBlockedFor(request.ip)
    if (wait > 0) {
      await audit.blocked(where(request), { scope: 'phone_code' })
      return tooManyRequests(reply, viewFor(request, user).view, wait)
    }
    const code = typeof request.body?.code === 'string' ? request.body.code.replaceAll(' ', '') : ''
    const result = /^\d{6}$/.test(code) ? await checkCode(db, { userId: user.id, purpose: 'activation', code }, { secrets: codeSecrets }) : undefined
    if (!result?.ok) {
      await limiter.codeFailed(request.ip)
      await audit.codeFailed(where(request), { userId: user.id, purpose: 'activation', reason: result?.reason ?? 'malformed' })
      return redirectWith(reply, PHONE, { kind: 'error', key: 'code.badOrExpired' })
    }
    await db.transaction((tx) => confirmPhone(tx, selfContext(request, user), user))
    return redirectWith(reply, ACCOUNT_PATH, { kind: 'ok', key: 'phone.doneTitle' })
  })
}
