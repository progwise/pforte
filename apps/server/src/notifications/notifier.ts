import type { Mailer } from './mailer.js'
import { activationMessage, loginCodeMessage, resetCodeMessage } from './messages.js'

export interface NotifiableUser {
  id: string
  email: string
  firstName: string
  lastName: string
  language: string
}

/** Sends messages to users. */
export interface Notifier {
  /** The code for the second factor, sent to the address or number the user has. */
  sendLoginCode(user: NotifiableUser, login: { code: string; expiresAt: Date }): Promise<void>
  /** The link a new user opens to set their first password. */
  sendActivationLink(user: NotifiableUser, link: { url: string; expiresAt: Date }): Promise<void>
  /** The code with which the user chooses a new password, and the page where they enter it. */
  sendResetCode(user: NotifiableUser, reset: { code: string; expiresAt: Date; url: string }): Promise<void>
}

/** No way to reach the user is configured. */
export class NotifierUnavailableError extends Error {}

/**
 * Writes what would be sent to the log, so the activation and reset flows can be tried in
 * development. It refuses in production: links and codes are secrets and must not end up in logs,
 * so without a real channel those actions fail with a clear message instead.
 */
export const createLogNotifier = ({
  log,
  production,
}: {
  log: (message: string) => void
  production: boolean
}): Notifier => {
  const guard = () => {
    if (production) {
      throw new NotifierUnavailableError(
        'No way to send messages is configured. Set SMTP_URL and MAIL_FROM.',
      )
    }
  }

  return {
    async sendLoginCode(user, { code, expiresAt }) {
      guard()
      log(`[development notifier] Sign-in code for ${user.email} (valid until ${expiresAt.toISOString()}): ${code}`)
    },
    async sendActivationLink(user, { url, expiresAt }) {
      guard()
      log(`[development notifier] Activation link for ${user.email} (valid until ${expiresAt.toISOString()}): ${url}`)
    },
    async sendResetCode(user, { code, expiresAt, url }) {
      guard()
      log(`[development notifier] Password reset code for ${user.email} (valid until ${expiresAt.toISOString()}): ${code}, page: ${url}`)
    },
  }
}

export interface MailNotifierSettings {
  mailer: Mailer
  /** Named in the messages, e.g. "Example Inc.". */
  organisation: string
}

/** Sends the messages by e-mail. */
export const createMailNotifier = ({ mailer, organisation }: MailNotifierSettings): Notifier => ({
  async sendLoginCode(user, { code, expiresAt }) {
    const minutes = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60_000))
    await mailer.send({ to: user.email, ...loginCodeMessage(user.language, { organisation, firstName: user.firstName, code, minutes }) })
  },
  async sendActivationLink(user, { url, expiresAt }) {
    const minutes = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 3_600_000))
    await mailer.send({ to: user.email, ...activationMessage(user.language, { organisation, firstName: user.firstName, url, minutes }) })
  },
  async sendResetCode(user, { code, expiresAt, url }) {
    const minutes = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60_000))
    await mailer.send({ to: user.email, ...resetCodeMessage(user.language, { organisation, firstName: user.firstName, code, minutes, url }) })
  },
})
