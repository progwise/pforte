export interface NotifiableUser {
  id: string
  email: string
  firstName: string
  lastName: string
  language: string
}

/** Sends messages to users. E-mail and SMS implementations arrive with the second factor (#6). */
export interface Notifier {
  /** The link a new user opens to set their first password. */
  sendActivationLink(user: NotifiableUser, link: { url: string; expiresAt: Date }): Promise<void>
  /** Sends the user a code to choose a new password; the notifier owns how the code is made and delivered. */
  requestPasswordReset(user: NotifiableUser): Promise<void>
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
        'No way to send messages is configured. E-mail and SMS are added with the second factor; until then these actions are not available in production.',
      )
    }
  }

  return {
    async sendActivationLink(user, { url, expiresAt }) {
      guard()
      log(`[development notifier] Activation link for ${user.email} (valid until ${expiresAt.toISOString()}): ${url}`)
    },
    async requestPasswordReset(user) {
      guard()
      log(`[development notifier] Password reset requested for ${user.email}`)
    },
  }
}
