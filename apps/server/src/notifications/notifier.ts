import type { Mailer } from './mailer.js'
import { activationMessage, loginCodeMessage, resetCodeMessage, smsMessage } from './messages.js'
import type { SmsSender } from './sms.js'

export type Channel = 'email' | 'sms'

export interface NotifiableUser {
  id: string
  email: string
  firstName: string
  lastName: string
  language: string
  phone: string | null
}

/** Sends messages to users. */
export interface Notifier {
  /** Whether codes can be sent by SMS. Without it, everything goes by e-mail. */
  readonly smsAvailable: boolean
  /** The code for the second factor, by the given channel. */
  sendLoginCode(user: NotifiableUser, login: { code: string; expiresAt: Date; channel: Channel }): Promise<void>
  /** The code with which the user chooses a new password, and the page where they enter it. */
  sendResetCode(user: NotifiableUser, reset: { code: string; expiresAt: Date; url: string; channel: Channel }): Promise<void>
  /** The code that confirms the user's phone number; always an SMS to that number. */
  sendPhoneCode(user: NotifiableUser, phone: { code: string; expiresAt: Date }): Promise<void>
  /** The link a new user opens to set their first password. */
  sendActivationLink(user: NotifiableUser, link: { url: string; expiresAt: Date }): Promise<void>
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
  smsAvailable = false,
}: {
  log: (message: string) => void
  production: boolean
  /** Pretend SMS can be sent, to try the flows that use it. */
  smsAvailable?: boolean
}): Notifier => {
  const guard = () => {
    if (production) {
      throw new NotifierUnavailableError('No way to send messages is configured. Set SMTP_URL and MAIL_FROM.')
    }
  }
  const until = (expiresAt: Date) => `valid until ${expiresAt.toISOString()}`

  return {
    smsAvailable,
    async sendLoginCode(user, { code, expiresAt, channel }) {
      guard()
      log(`[development notifier] Sign-in code for ${user.email} by ${channel} (${until(expiresAt)}): ${code}`)
    },
    async sendActivationLink(user, { url, expiresAt }) {
      guard()
      log(`[development notifier] Activation link for ${user.email} (${until(expiresAt)}): ${url}`)
    },
    async sendResetCode(user, { code, expiresAt, url, channel }) {
      guard()
      log(`[development notifier] Password reset code for ${user.email} by ${channel} (${until(expiresAt)}): ${code}, page: ${url}`)
    },
    async sendPhoneCode(user, { code, expiresAt }) {
      guard()
      log(`[development notifier] Code to confirm the phone ${user.phone} of ${user.email} (${until(expiresAt)}): ${code}`)
    },
  }
}

export interface MailNotifierSettings {
  mailer: Mailer
  /** Without it, everything goes by e-mail. */
  sms?: SmsSender
  /** Named in the messages, e.g. "Example Inc.". */
  organisation: string
}

const minutesUntil = (expiresAt: Date) => Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60_000))

/** Sends the messages by e-mail and, where configured, by SMS. */
export const createMailNotifier = ({ mailer, sms, organisation }: MailNotifierSettings): Notifier => {
  const text = (user: NotifiableUser, kind: 'login' | 'reset' | 'phone', code: string, expiresAt: Date) =>
    smsMessage(kind, user.language, { organisation, code, minutes: minutesUntil(expiresAt) })

  const sendSms = async (user: NotifiableUser, message: string) => {
    if (!sms || !user.phone) throw new NotifierUnavailableError('The user cannot be reached by SMS.')
    await sms.send({ to: user.phone, text: message })
  }

  return {
    smsAvailable: Boolean(sms),
    async sendLoginCode(user, { code, expiresAt, channel }) {
      if (channel === 'sms') return sendSms(user, text(user, 'login', code, expiresAt))
      const minutes = minutesUntil(expiresAt)
      await mailer.send({ to: user.email, ...loginCodeMessage(user.language, { organisation, firstName: user.firstName, code, minutes }) })
    },
    async sendActivationLink(user, { url, expiresAt }) {
      const hours = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 3_600_000))
      await mailer.send({ to: user.email, ...activationMessage(user.language, { organisation, firstName: user.firstName, url, minutes: hours }) })
    },
    async sendResetCode(user, { code, expiresAt, url, channel }) {
      if (channel === 'sms') return sendSms(user, `${text(user, 'reset', code, expiresAt)} ${url}`)
      const minutes = minutesUntil(expiresAt)
      await mailer.send({ to: user.email, ...resetCodeMessage(user.language, { organisation, firstName: user.firstName, code, minutes, url }) })
    },
    async sendPhoneCode(user, { code, expiresAt }) {
      await sendSms(user, text(user, 'phone', code, expiresAt))
    },
  }
}
