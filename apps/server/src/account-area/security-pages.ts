import { endSessions, listClients, listDevices, listSignInEvents, listUserSessions, type RequestContext, revokeAllDevices, revokeDevice } from '@progwise/pforte-db/admin'
import { CodeLimitError } from '@progwise/pforte-db/codes'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ACR_SECOND_FACTOR } from '../auth/assurance.js'
import type { MessageKey } from '../i18n/index.js'
import { NotifierUnavailableError } from '../notifications/notifier.js'
import { escapeHtml } from '../ui/pages.js'
import { ACCOUNT_PATH } from './constants.js'
import { listTable } from './list.js'
import type { AccountContext } from './routes.js'
import type { AccountUser } from './session.js'

const SESSIONS = `${ACCOUNT_PATH}/sessions`
const DEVICES = `${ACCOUNT_PATH}/devices`
const SIGN_INS = `${ACCOUNT_PATH}/sign-ins`
const PASSWORD = `${ACCOUNT_PATH}/password`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHOWN_SIGN_INS = 10

/**
 * The pages where a person protects their own account: where they are signed in, the devices that are
 * remembered, their recent sign-ins and a new password. Every one of them asks `requireAccountSession` who the
 * person is and passes that person, and nobody else, to functions that already exist for the administration.
 * Every change asks for a recent sign-in first and is recorded with the person as the actor and `self: true`.
 */
export const registerSecurityPages = (app: FastifyInstance, ctx: AccountContext) => {
  const { db, gate, viewFor, page, redirectWith, requireRecentSignIn, formatTime, clientLogouts, sendPasswordResetCode, limiter, audit } = ctx

  /** Who did it, for the audit log: the person themselves. */
  const selfContext = (request: FastifyRequest, user: AccountUser): RequestContext => ({
    actor: { type: 'user', id: user.id },
    ip: request.ip,
    userAgent: request.headers['user-agent'],
    self: true,
  })

  // --- Where I am signed in

  app.get(SESSIONS, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user } = signedIn
    const { t, language } = viewFor(request, user)

    const names = new Map((await listClients(db)).map((client) => [client.clientId, client.name]))
    const nameOf = (clientId: string) => names.get(clientId) ?? clientId
    const { sessions, grants } = await listUserSessions(db, user.id)

    const browsers = listTable(
      [t('account.sessions.started'), t('account.sessions.until'), t('account.sessions.how'), t('account.sessions.applications')],
      sessions.map((session) =>
        [
          formatTime(session.startedAt, language),
          formatTime(session.expiresAt, language),
          t(session.amr.includes('pop') ? 'account.sessions.withPasskey' : session.acr === ACR_SECOND_FACTOR ? 'account.sessions.withCode' : 'account.sessions.withoutCode'),
          session.clientIds.length ? session.clientIds.map(nameOf).join(', ') : t('account.sessions.noApplications'),
        ].map(escapeHtml),
      ),
    )
    // Every sign-in in a browser leaves a grant, also for an application that is signed in only as long as that
    // browser session lasts. Those are in the table above. Here are the ones that hold a refresh token.
    const staying = grants.filter((grant) => grant.staysSignedIn)
    const applications = staying.length
      ? listTable(
          [t('account.sessions.applications'), t('account.sessions.since'), t('account.sessions.until')],
          staying.map((grant) => [nameOf(grant.clientId), formatTime(grant.since, language), formatTime(grant.expiresAt, language)].map(escapeHtml)),
        )
      : `<p class="muted">${escapeHtml(t('account.sessions.noGrants'))}</p>`
    const content = `<h1>${escapeHtml(t('account.sessions.title'))}</h1>
<h2>${escapeHtml(t('account.sessions.browsers'))}</h2>
<div class="panel">
<p class="muted">${escapeHtml(t('account.sessions.browsersHelp'))}</p>
${browsers}
</div>
<h2>${escapeHtml(t('account.sessions.grants'))}</h2>
<div class="panel">
<p class="muted">${escapeHtml(t('account.sessions.grantsHelp'))}</p>
${applications}
</div>
<h2>${escapeHtml(t('account.sessions.endAll.title'))}</h2>
<div class="panel">
<p class="muted">${escapeHtml(t('account.sessions.endAll.help'))}</p>
<form method="post" action="${SESSIONS}/end"><button type="submit" class="secondary">${escapeHtml(t('account.sessions.endAll.button'))}</button></form>
</div>`
    return reply.type('text/html').send(page(request, reply, user, 'sessions', t('account.sessions.title'), content))
  })

  app.post(`${SESSIONS}/end`, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user, session } = signedIn
    if (!requireRecentSignIn(reply, session, SESSIONS)) return reply

    const ended = await db.transaction((tx) => endSessions(tx, selfContext(request, user), user))
    // The applications are told as when an administrator does it. This page's own sign-in is among what ended.
    clientLogouts.send(user, ended.logouts)
    reply.header('Set-Cookie', gate.end())
    return redirectWith(reply, `${ACCOUNT_PATH}/signed-out`, { kind: 'ok', key: 'account.sessions.endAll.done', language: user.language })
  })

  // --- Remembered devices

  app.get(DEVICES, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user } = signedIn
    const { t, language } = viewFor(request, user)

    const devices = await listDevices(db, user.id)
    const list = devices.length
      ? `${listTable(
          [t('account.devices.browser'), t('account.devices.lastSeen'), t('account.devices.until'), ''],
          devices.map((device) => [
            ...[device.userAgent ?? t('account.devices.unknown'), formatTime(device.lastSeenAt, language), formatTime(device.expiresAt, language)].map(escapeHtml),
            `<form method="post" action="${DEVICES}/forget"><input type="hidden" name="device" value="${escapeHtml(device.id)}"><button type="submit" class="secondary">${escapeHtml(t('account.devices.forget'))}</button></form>`,
          ]),
        )}
<form class="below" method="post" action="${DEVICES}/forget-all"><button type="submit" class="secondary">${escapeHtml(t('account.devices.forgetAll'))}</button></form>`
      : `<p class="muted">${escapeHtml(t('account.devices.none'))}</p>`
    const content = `<h1>${escapeHtml(t('account.devices.title'))}</h1>
<div class="panel">
<p class="muted">${escapeHtml(t('account.devices.help'))}</p>
${list}
</div>`
    return reply.type('text/html').send(page(request, reply, user, 'devices', t('account.devices.title'), content))
  })

  app.post<{ Body: Record<string, unknown> }>(`${DEVICES}/forget`, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user, session } = signedIn
    if (!requireRecentSignIn(reply, session, DEVICES)) return reply

    // What the person picked is an id of a device, never of a person, and the query asks for it among this
    // person's devices only: somebody else's device is "not remembered", exactly as one that does not exist.
    const deviceId = typeof request.body?.device === 'string' ? request.body.device : ''
    const forgotten = UUID.test(deviceId) && (await db.transaction((tx) => revokeDevice(tx, selfContext(request, user), user, deviceId)))
    return redirectWith(reply, DEVICES, forgotten ? { kind: 'ok', key: 'account.devices.forgotten' } : { kind: 'error', key: 'account.devices.gone' })
  })

  app.post(`${DEVICES}/forget-all`, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user, session } = signedIn
    if (!requireRecentSignIn(reply, session, DEVICES)) return reply

    await db.transaction((tx) => revokeAllDevices(tx, selfContext(request, user), user))
    return redirectWith(reply, DEVICES, { kind: 'ok', key: 'account.devices.allForgotten' })
  })

  // --- Recent sign-ins

  app.get(SIGN_INS, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user } = signedIn
    const { t, language } = viewFor(request, user)

    const what = (action: string, details: unknown): MessageKey => {
      const method = (details as { method?: unknown } | null)?.method
      if (action === 'login.succeeded') return method === 'remembered_device' ? 'account.signIns.succeededDevice' : method === 'passkey' ? 'account.signIns.succeededPasskey' : 'account.signIns.succeededCode'
      if (action === 'login.passkey_failed') return 'account.signIns.passkeyFailed'
      if (action === 'login.password_failed') return 'account.signIns.passwordFailed'
      if (action === 'login.code_failed') return 'account.signIns.codeFailed'
      return 'account.signIns.blocked'
    }
    const events = await listSignInEvents(db, user.id, SHOWN_SIGN_INS)
    const list = events.length
      ? listTable(
          [t('account.signIns.when'), t('account.signIns.what'), t('account.signIns.from'), t('account.signIns.browser')],
          events.map((event) => [formatTime(event.createdAt, language), t(what(event.action, event.details)), event.ip ?? '', event.userAgent ?? ''].map(escapeHtml)),
        )
      : `<p class="muted">${escapeHtml(t('account.signIns.none'))}</p>`
    const content = `<h1>${escapeHtml(t('account.signIns.title'))}</h1>
<div class="panel">
<p class="muted">${escapeHtml(t('account.signIns.help'))}</p>
${list}
</div>`
    return reply.type('text/html').send(page(request, reply, user, 'sign-ins', t('account.signIns.title'), content))
  })

  // --- A new password: the reset that exists, started for the person who is signed in

  app.get(PASSWORD, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user } = signedIn
    const { t } = viewFor(request, user)
    const content = `<h1>${escapeHtml(t('account.password.title'))}</h1>
<div class="panel">
<p>${escapeHtml(t('account.password.help'))}</p>
<form method="post" action="${PASSWORD}"><button type="submit">${escapeHtml(t('account.password.button'))}</button></form>
</div>`
    return reply.type('text/html').send(page(request, reply, user, 'password', t('account.password.title'), content))
  })

  app.post(PASSWORD, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user, session } = signedIn
    if (!requireRecentSignIn(reply, session, PASSWORD)) return reply

    const where = { ip: request.ip, userAgent: request.headers['user-agent'] }
    const waitMessage = (seconds: number) => ({ kind: 'error' as const, key: 'account.password.wait' as const, values: { minutes: Math.max(1, Math.ceil(seconds / 60)) } })

    // The same limit as on the page for a forgotten password: this is that request, made by somebody we know.
    const wait = await limiter.resetRequest(user.email, request.ip)
    if (wait > 0) {
      await audit.blocked(where, { scope: 'reset', email: user.email })
      return redirectWith(reply, PASSWORD, waitMessage(wait))
    }
    try {
      const channel = await sendPasswordResetCode(user)
      await audit.resetRequested(where, { userId: user.id })
      await audit.codeSent(where, { userId: user.id, purpose: 'password_reset', channel })
    } catch (error) {
      if (error instanceof CodeLimitError) return redirectWith(reply, PASSWORD, waitMessage(error.retryAfterSeconds))
      if (!(error instanceof NotifierUnavailableError)) throw error
      request.log.error(error, 'the password reset code could not be sent')
      return redirectWith(reply, PASSWORD, { kind: 'error', key: 'account.password.unavailable' })
    }
    // There is no password field here. The new password is chosen on the page of the reset, with the code that
    // was just sent, and that page ends every session, as it does for a forgotten password.
    return reply.redirect(`/reset/code?email=${encodeURIComponent(user.email)}&lang=${encodeURIComponent(user.language)}`, 303)
  })
}
