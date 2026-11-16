import { addPasskey, listPasskeys, MAX_PASSKEYS, openPasskeyChallenge, type RequestContext, removePasskey, takePasskeyChallenge } from '@progwise/pforte-db/admin'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { NotifierUnavailableError } from '../notifications/notifier.js'
import { passkeyLabel } from '../passkeys/index.js'
import { escapeHtml } from '../ui/pages.js'
import { ACCOUNT_PATH } from './constants.js'
import type { AccountContext } from './routes.js'
import { STEP_UP_SECONDS } from './routes.js'
import type { AccountUser } from './session.js'

const PASSKEYS = `${ACCOUNT_PATH}/passkeys`
const NEW = `${PASSKEYS}/new`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The challenge an answer says it is for. It is read from the answer only to find the question; whether the answer is one is checked after. */
const challengeNamedBy = (answer: unknown) => {
  try {
    const clientData = (answer as { response?: { clientDataJSON?: unknown } } | null)?.response?.clientDataJSON
    const challenge = typeof clientData === 'string' ? (JSON.parse(Buffer.from(clientData, 'base64url').toString()) as { challenge?: unknown } | null)?.challenge : undefined
    return typeof challenge === 'string' && challenge ? challenge : undefined
  } catch {
    return undefined
  }
}

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
  const { db, issuer, gate, viewFor, page, redirectWith, requireRecentSignIn, formatTime, passkeys, notifier, background } = ctx

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

    const cell = (text: string) => `<td>${escapeHtml(text)}</td>`
    const own = await listPasskeys(db, user.id)
    const list = own.length
      ? `<div class="scroll"><table class="list">
<thead><tr><th>${escapeHtml(t('account.passkeys.createdWith'))}</th><th>${escapeHtml(t('account.passkeys.created'))}</th><th>${escapeHtml(t('account.passkeys.lastUsed'))}</th><th></th></tr></thead>
<tbody>
${own
  .map(
    (passkey) =>
      `<tr>${cell(passkey.label ?? t('account.passkeys.unknown'))}${cell(formatTime(passkey.createdAt, language))}${cell(passkey.lastUsedAt ? formatTime(passkey.lastUsedAt, language) : t('account.passkeys.never'))}
<td><form method="post" action="${PASSKEYS}/remove"><input type="hidden" name="passkey" value="${escapeHtml(passkey.id)}"><button type="submit" class="secondary">${escapeHtml(t('account.passkeys.remove'))}</button></form></td></tr>`,
  )
  .join('\n')}
</tbody></table></div>`
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

    const own = await listPasskeys(db, user.id)
    if (own.length >= MAX_PASSKEYS) return redirectWith(reply, PASSKEYS, { kind: 'error', key: 'account.passkeys.tooMany', values: { count: String(MAX_PASSKEYS) } })

    const options = await passkeys.ceremonies.creationOptions(user, own)
    await openPasskeyChallenge(db, { challenge: options.challenge, userId: user.id, grantId: session.grantId }, new Date(Date.now() + STEP_UP_SECONDS * 1000))
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

    let answer: unknown
    try {
      answer = JSON.parse(typeof request.body?.credential === 'string' ? request.body.credential : '')
    } catch {
      answer = undefined
    }
    const challenge = challengeNamedBy(answer)
    if (!challenge) return redirectWith(reply, PASSKEYS, { kind: 'error', key: 'account.passkeys.rejected' })

    // The question is good for one answer, whatever that answer turns out to be: it is used up here, before the
    // answer is looked at. One that was never asked, was asked of somebody else or in another sign-in, has run
    // out or was answered before is not there.
    if (!(await takePasskeyChallenge(db, { challenge, userId: user.id, grantId: session.grantId }))) return redirectWith(reply, PASSKEYS, { kind: 'error', key: 'account.passkeys.expired' })

    const created = await passkeys.ceremonies.verifyCreation(answer, challenge)
    if (!created) return redirectWith(reply, PASSKEYS, { kind: 'error', key: 'account.passkeys.rejected' })

    const label = passkeyLabel(request.headers['user-agent'])
    const added = await db.transaction((tx) => addPasskey(tx, selfContext(request, user), user, { ...created, label }))
    if (added.kind === 'too-many') return redirectWith(reply, PASSKEYS, { kind: 'error', key: 'account.passkeys.tooMany', values: { count: String(MAX_PASSKEYS) } })
    if (added.kind === 'duplicate') return redirectWith(reply, PASSKEYS, { kind: 'error', key: 'account.passkeys.duplicate' })

    // The rightful person learns of a passkey that somebody else added. Not tied to the response: a mail server
    // that is down must not turn a passkey that exists into an error.
    const { t } = viewFor(request, user)
    background.run(async () => {
      try {
        await notifier.sendPasskeyAdded(user, { device: label ?? t('account.passkeys.unknown'), url: `${issuer}${PASSKEYS}` })
      } catch (error) {
        if (error instanceof NotifierUnavailableError) request.log.error(error, 'the notice that a passkey was added could not be sent')
        else throw error
      }
    })
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
