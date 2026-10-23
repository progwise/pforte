import { type NotifiableUser, type Notifier, NotifierUnavailableError } from '../notifications/notifier.js'

export interface Notification {
  kind: 'activation' | 'reset-code' | 'login-code' | 'phone-code'
  user: NotifiableUser
  channel?: 'email' | 'sms'
  url?: string
  code?: string
  expiresAt?: Date
  applicationName?: string
}

/** A notifier that keeps what it was asked to send, and can be told to fail. */
export const createRecordingNotifier = () => {
  const notifications: Notification[] = []
  const notifier: Notifier & { failWith?: Error; smsAvailable: boolean; failSms?: boolean; hold?: Promise<void> } = {
    smsAvailable: false,
    async sendLoginCode(user, login) {
      if (notifier.failWith) throw notifier.failWith
      if (login.channel === 'sms' && notifier.failSms) throw new NotifierUnavailableError('SMS is down')
      notifications.push({ kind: 'login-code', user, channel: login.channel, code: login.code, expiresAt: login.expiresAt })
    },
    async sendPhoneCode(user, phone) {
      if (notifier.failWith) throw notifier.failWith
      if (notifier.failSms) throw new NotifierUnavailableError('SMS is down')
      notifications.push({ kind: 'phone-code', user, channel: 'sms', code: phone.code, expiresAt: phone.expiresAt })
    },
    async sendActivationLink(user, link) {
      if (notifier.failWith) throw notifier.failWith
      notifications.push({ kind: 'activation', user, url: link.url, expiresAt: link.expiresAt, applicationName: link.applicationName })
    },
    async sendResetCode(user, reset) {
      await notifier.hold
      if (notifier.failWith) throw notifier.failWith
      if (reset.channel === 'sms' && notifier.failSms) throw new NotifierUnavailableError('SMS is down')
      notifications.push({ kind: 'reset-code', user, channel: reset.channel, code: reset.code, url: reset.url, expiresAt: reset.expiresAt })
    },
  }
  /** The newest sign-in code sent to this e-mail address. */
  const lastCode = (email: string) => notifications.findLast((n) => n.kind === 'login-code' && n.user.email === email)?.code
  /** The newest code to confirm a phone number sent to this e-mail address's owner. */
  const lastPhoneCode = (email: string) => notifications.findLast((n) => n.kind === 'phone-code' && n.user.email === email)?.code
  /** The newest password reset code sent to this e-mail address. */
  const lastResetCode = (email: string) => notifications.findLast((n) => n.kind === 'reset-code' && n.user.email === email)?.code
  return { notifier, notifications, lastCode, lastResetCode, lastPhoneCode }
}
