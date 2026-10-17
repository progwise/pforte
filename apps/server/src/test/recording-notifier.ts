import type { NotifiableUser, Notifier } from '../notifications/notifier.js'

export interface Notification {
  kind: 'activation' | 'password-reset' | 'login-code'
  user: NotifiableUser
  url?: string
  code?: string
  expiresAt?: Date
}

/** A notifier that keeps what it was asked to send, and can be told to fail. */
export const createRecordingNotifier = () => {
  const notifications: Notification[] = []
  const notifier: Notifier & { failWith?: Error } = {
    async sendLoginCode(user, login) {
      if (notifier.failWith) throw notifier.failWith
      notifications.push({ kind: 'login-code', user, code: login.code, expiresAt: login.expiresAt })
    },
    async sendActivationLink(user, link) {
      if (notifier.failWith) throw notifier.failWith
      notifications.push({ kind: 'activation', user, url: link.url, expiresAt: link.expiresAt })
    },
    async requestPasswordReset(user) {
      if (notifier.failWith) throw notifier.failWith
      notifications.push({ kind: 'password-reset', user })
    },
  }
  /** The newest sign-in code sent to this e-mail address. */
  const lastCode = (email: string) => notifications.findLast((n) => n.kind === 'login-code' && n.user.email === email)?.code
  return { notifier, notifications, lastCode }
}
