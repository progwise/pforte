import type { Database } from '@progwise/pforte-db'
import { addPasskey, listPasskeys, MAX_PASSKEYS, openPasskeyChallenge, type RequestContext, takePasskeyChallenge } from '@progwise/pforte-db/admin'
import type { findActiveUserById } from '@progwise/pforte-db/oidc'
import type { FastifyRequest } from 'fastify'
import { type Notifier, NotifierUnavailableError } from '../notifications/notifier.js'
import type { Background } from '../security/background.js'
import type { Ui } from '../ui/index.js'
import { namedBy, type PasskeyCeremonies } from './ceremonies.js'
import { passkeyLabel } from './label.js'

type ActiveUser = NonNullable<Awaited<ReturnType<typeof findActiveUserById>>>

export interface PasskeyEnrolmentDependencies {
  db: Database
  ceremonies: PasskeyCeremonies
  ui: Pick<Ui, 'i18n'>
  /** Tells a person that a passkey was added to their account. */
  notifier: Pick<Notifier, 'sendPasskeyAdded'>
  /** Runs what must not delay an answer. */
  background: Background
  /** Where a person sees and removes their passkeys, for the mail. Left out when there are no account pages. */
  accountUrl?: string
}

/** How an attempt to add a passkey ended. */
export type EnrolmentOutcome = 'added' | 'rejected' | 'expired' | 'duplicate' | 'too-many'

/**
 * Making a passkey for a person, the same wherever it is offered: on the account pages, after a sign-in with a
 * code, after an activation. The place decides who the person is and that they may; this asks the device and
 * takes its answer.
 *
 * `boundTo` names the place a question is asked in. Its answer is taken there and nowhere else, once.
 */
export const createPasskeyEnrolment = ({ db, ceremonies, ui, notifier, background, accountUrl }: PasskeyEnrolmentDependencies) => ({
  /** What to ask the device, noted for `seconds`. Undefined if the person has as many passkeys as they may. */
  ask: async (user: ActiveUser, boundTo: string, seconds: number) => {
    const own = await listPasskeys(db, user.id)
    if (own.length >= MAX_PASSKEYS) return undefined
    const options = await ceremonies.creationOptions(user, own)
    await openPasskeyChallenge(db, { challenge: options.challenge, userId: user.id, boundTo }, new Date(Date.now() + seconds * 1000))
    return options
  },

  /**
   * Takes what the form brought back (`credential`, the device's answer as JSON) and stores the passkey if the
   * answer holds. The person is told by e-mail, after the answer to the browser.
   */
  complete: async (request: FastifyRequest, user: ActiveUser, boundTo: string, credential: unknown): Promise<EnrolmentOutcome> => {
    let answer: unknown
    try {
      answer = JSON.parse(typeof credential === 'string' ? credential : '')
    } catch {
      return 'rejected'
    }
    const { challenge } = namedBy(answer)
    if (!challenge) return 'rejected'

    // The question is good for one answer, whatever that answer turns out to be: it is used up here, before the
    // answer is looked at. One that was never asked, was asked of somebody else or in another place, has run out
    // or was answered before is not there.
    if (!(await takePasskeyChallenge(db, { challenge, userId: user.id, boundTo }))) return 'expired'

    const created = await ceremonies.verifyCreation(answer, challenge)
    if (!created) return 'rejected'

    const label = passkeyLabel(request.headers['user-agent'])
    // The person themselves, wherever they are asked: nobody makes a passkey for somebody else.
    const context: RequestContext = { actor: { type: 'user', id: user.id }, ip: request.ip, userAgent: request.headers['user-agent'], self: true }
    const added = await db.transaction((tx) => addPasskey(tx, context, user, { ...created, label }))
    if (added.kind !== 'added') return added.kind

    // The rightful person learns of a passkey that somebody else added. Not tied to the response: a mail server
    // that is down must not turn a passkey that exists into an error.
    background.run(async () => {
      try {
        await notifier.sendPasskeyAdded(user, { device: label ?? ui.i18n.text(ui.i18n.pick(user.language), 'account.passkeys.unknown'), url: accountUrl })
      } catch (error) {
        if (error instanceof NotifierUnavailableError) request.log.error(error, 'the notice that a passkey was added could not be sent')
        else throw error
      }
    })
    return 'added'
  },
})

export type PasskeyEnrolment = ReturnType<typeof createPasskeyEnrolment>
