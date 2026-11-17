import { isGrantLive, listPasskeys, MAX_PASSKEYS, type RequestContext, removePasskey } from '@progwise/pforte-db/admin'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { escapeHtml } from '../ui/pages.js'
import { ACCOUNT_PATH, ACCOUNT_UI_CLIENT_ID } from './constants.js'
import { listTable } from './list.js'
import type { AccountContext } from './routes.js'
import { STEP_UP_SECONDS } from './routes.js'
import type { AccountSession, AccountUser } from './session.js'

const PASSKEYS = `${ACCOUNT_PATH}/passkeys`
const NEW = `${PASSKEYS}/new`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The pages where a person sees their passkeys, adds one and removes one. As on the other pages of the area,
 * who the person is comes from `requireAccountSession` alone, and a change needs a recent sign-in.
 *
 * Adding is the one change that takes two requests, with the device's own question in between. The recent
 * sign-in is asked for when that question is handed out, and its answer is accepted for as long as a sign-in
 * counts as recent. Asking again at the answer could refuse a passkey the device has already made, and the
 * person would be left with a passkey on their phone that pforte does not know.
 *
 * The question is kept at pforte, for the person and the sign-in it was asked in, and is used up by the first
 * answer that names it. So an answer works once: not a second time, and not again after its passkey was removed.
 */
export const registerPasskeyPages = (app: FastifyInstance, ctx: AccountContext) => {
  const { db, gate, viewFor, page, redirectWith, requireRecentSignIn, formatTime, passkeys } = ctx

  /** A question belongs to the sign-in at the account pages it was asked in. */
  const boundTo = (session: AccountSession) => `account:${session.grantId}`

  const selfContext = (request: FastifyRequest, user: AccountUser): RequestContext => ({
    actor: { type: 'user', id: user.id },
    ip: request.ip,
    userAgent: request.headers['user-agent'],
    self: true,
  })

  app.get(PASSKEYS, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user } = signedIn
    const { t, language } = viewFor(request, user)

    const own = await listPasskeys(db, user.id)
    const list = own.length
      ? listTable(
          [t('account.passkeys.createdWith'), t('account.passkeys.created'), t('account.passkeys.lastUsed'), ''],
          own.map((passkey) => [
            ...[passkey.label ?? t('account.passkeys.unknown'), formatTime(passkey.createdAt, language), passkey.lastUsedAt ? formatTime(passkey.lastUsedAt, language) : t('account.passkeys.never')].map(escapeHtml),
            `<form method="post" action="${PASSKEYS}/remove"><input type="hidden" name="passkey" value="${escapeHtml(passkey.id)}"><button type="submit" class="secondary">${escapeHtml(t('account.passkeys.remove'))}</button></form>`,
          ]),
        )
      : `<p class="muted">${escapeHtml(t('account.passkeys.none'))}</p>`
    const content = `<h1>${escapeHtml(t('account.passkeys.title'))}</h1>
<div class="panel">
<p class="muted">${escapeHtml(t('account.passkeys.help'))}</p>
${list}
<p><a class="button" href="${NEW}">${escapeHtml(t('account.passkeys.add'))}</a></p>
</div>`
    return reply.type('text/html').send(page(request, reply, user, 'passkeys', t('account.passkeys.title'), content))
  })

  // --- Adding one: this page hands the device its question, the form below it brings the answer

  app.get(NEW, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user, session } = signedIn
    if (!requireRecentSignIn(reply, session, NEW)) return reply
    const { t } = viewFor(request, user)

    const options = await passkeys.enrolment.ask(user, boundTo(session), STEP_UP_SECONDS)
    if (!options) return redirectWith(reply, PASSKEYS, { kind: 'error', key: 'account.passkeys.tooMany', values: { count: String(MAX_PASSKEYS) } })
    passkeys.script.allow(reply)

    // Without the script, or in a browser that knows no passkeys, the page stays as it is sent: the button
    // disabled and the reason said. The script enables the one and hides the other.
    const content = `<h1>${escapeHtml(t('account.passkeys.new.title'))}</h1>
<div class="panel">
<p>${escapeHtml(t('account.passkeys.new.text'))}</p>
<form method="post" action="${NEW}" ${passkeys.script.createAttributes(options)}>
<input type="hidden" name="credential">
<p class="error" role="alert" data-passkey-message="unsupported">${escapeHtml(t('account.passkeys.new.unsupported'))}</p>
<p class="error" role="alert" data-passkey-message="failed" hidden>${escapeHtml(t('account.passkeys.new.failed'))}</p>
<p class="error" role="alert" data-passkey-message="exists" hidden>${escapeHtml(t('account.passkeys.new.exists'))}</p>
<div class="actions">
<button type="submit" disabled>${escapeHtml(t('account.passkeys.new.button'))}</button>
<a class="button secondary" href="${PASSKEYS}">${escapeHtml(t('account.passkeys.new.back'))}</a>
</div>
</form>
</div>
${passkeys.script.tag}`
    return reply.type('text/html').send(page(request, reply, user, 'passkeys', t('account.passkeys.new.title'), content))
  })

  app.post<{ Body: Record<string, unknown> }>(NEW, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user, session } = signedIn

    // The sign-in this session came from must still exist when the passkey is stored, not only when the request came in.
    const outcome = await passkeys.enrolment.complete(request, user, boundTo(session), request.body?.credential, (tx) =>
      isGrantLive(tx, { grantId: session.grantId, userId: user.id, clientId: ACCOUNT_UI_CLIENT_ID }),
    )
    if (outcome === 'revoked') return reply.header('Set-Cookie', gate.end()).redirect(`${ACCOUNT_PATH}/login`, 303)
    if (outcome === 'too-many') return redirectWith(reply, PASSKEYS, { kind: 'error', key: 'account.passkeys.tooMany', values: { count: String(MAX_PASSKEYS) } })
    if (outcome !== 'added') return redirectWith(reply, PASSKEYS, { kind: 'error', key: `account.passkeys.${outcome}` })
    return redirectWith(reply, PASSKEYS, { kind: 'ok', key: 'account.passkeys.added' })
  })

  app.post<{ Body: Record<string, unknown> }>(`${PASSKEYS}/remove`, async (request, reply) => {
    const signedIn = await gate.requireAccountSession(request, reply)
    if (!signedIn) return reply
    const { user, session } = signedIn
    if (!requireRecentSignIn(reply, session, PASSKEYS)) return reply

    // As with a device: the id is looked for among this person's passkeys only, so somebody else's is "gone",
    // exactly as one that does not exist.
    const passkeyId = typeof request.body?.passkey === 'string' ? request.body.passkey : ''
    const removed = UUID.test(passkeyId) && (await db.transaction((tx) => removePasskey(tx, selfContext(request, user), user, passkeyId)))
    return redirectWith(reply, PASSKEYS, removed ? { kind: 'ok', key: 'account.passkeys.removed' } : { kind: 'error', key: 'account.passkeys.gone' })
  })
}
