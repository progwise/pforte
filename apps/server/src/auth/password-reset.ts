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

/**
 * Sends the code and says by which channel it went. `clientId` is the application the person is on their way to:
 * the link to the page for the code carries it, and the page ends with a button to that application's start address.
 */
export type SendPasswordResetCode = (user: NotifiableUser & Reachable, options?: { clientId?: string }) => Promise<Channel>

/**
 * Sends the user a code for choosing a new password, by SMS if they have a confirmed number and by
 * e-mail otherwise. Throws `CodeLimitError` when codes were requested too often, and
 * `NotifierUnavailableError` when nothing can be sent.
 */
export const createPasswordResetSender =
  ({ db, notifier, codeSecrets, issuer }: PasswordResetDependencies): SendPasswordResetCode =>
  async (user, { clientId } = {}) => {
    const channel = channelFor(user, notifier)
    const { code, expiresAt } = await issueCode(db, { userId: user.id, channel, purpose: 'password_reset' }, { secrets: codeSecrets })
    // Only the ID of the client travels in the link. The page looks the client up and links nothing but the
    // address that is registered for it, so a link somebody made up leads nowhere of their choosing.
    const to = clientId ? `&client_id=${encodeURIComponent(clientId)}` : ''
    await notifier.sendResetCode(user, { code, expiresAt, channel, url: `${issuer}/reset/code?email=${encodeURIComponent(user.email)}&lang=${encodeURIComponent(user.language)}${to}` })
    return channel
  }
