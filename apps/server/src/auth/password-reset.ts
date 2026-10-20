import type { Database } from '@progwise/pforte-db'
import { issueCode } from '@progwise/pforte-db/codes'
import type { Channel, NotifiableUser, Notifier } from '../notifications/notifier.js'
import { channelFor, type Reachable } from './channels.js'

export interface PasswordResetDependencies {
  db: Database
  notifier: Notifier
  codeSecrets: string[]
  /** The public address of pforte, where the page to enter the code lives. */
  issuer: string
}

/** Sends the code and says by which channel it went. */
export type SendPasswordResetCode = (user: NotifiableUser & Reachable) => Promise<Channel>

/**
 * Sends the user a code for choosing a new password, by SMS if they have a confirmed number and by
 * e-mail otherwise. Throws `CodeLimitError` when codes were requested too often, and
 * `NotifierUnavailableError` when nothing can be sent.
 */
export const createPasswordResetSender =
  ({ db, notifier, codeSecrets, issuer }: PasswordResetDependencies): SendPasswordResetCode =>
  async (user) => {
    const channel = channelFor(user, notifier)
    const { code, expiresAt } = await issueCode(db, { userId: user.id, channel, purpose: 'password_reset' }, { secrets: codeSecrets })
    await notifier.sendResetCode(user, { code, expiresAt, channel, url: `${issuer}/reset/code?email=${encodeURIComponent(user.email)}&lang=${encodeURIComponent(user.language)}` })
    return channel
  }
