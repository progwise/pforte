import type { Database } from '@progwise/pforte-db'
import { issueCode } from '@progwise/pforte-db/codes'
import type { NotifiableUser, Notifier } from '../notifications/notifier.js'

export interface PasswordResetDependencies {
  db: Database
  notifier: Notifier
  codeSecrets: string[]
  /** The public address of pforte, where the page to enter the code lives. */
  issuer: string
}

export type SendPasswordResetCode = (user: NotifiableUser) => Promise<void>

/**
 * Sends the user a code for choosing a new password. Throws `CodeLimitError` when codes were requested
 * too often, and `NotifierUnavailableError` when nothing can be sent.
 */
export const createPasswordResetSender =
  ({ db, notifier, codeSecrets, issuer }: PasswordResetDependencies): SendPasswordResetCode =>
  async (user) => {
    const { code, expiresAt } = await issueCode(db, { userId: user.id, channel: 'email', purpose: 'password_reset' }, { secrets: codeSecrets })
    await notifier.sendResetCode(user, { code, expiresAt, url: `${issuer}/reset/code?email=${encodeURIComponent(user.email)}` })
  }
