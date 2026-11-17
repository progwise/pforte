import type { Channel, Notifier } from '../notifications/notifier.js'

export interface Reachable {
  phone: string | null
  phoneVerifiedAt: Date | null
}

/**
 * Where a code goes: by SMS to a phone number the user has confirmed, otherwise by e-mail. A number that
 * was only entered by the back office is not used, as a mistyped one would send codes to a stranger.
 */
export const channelFor = (user: Reachable, notifier: Pick<Notifier, 'smsAvailable'>): Channel =>
  notifier.smsAvailable && user.phone && user.phoneVerifiedAt ? 'sms' : 'email'

/**
 * Whether the person has a phone number that codes could go to, if only it were confirmed. Without SMS in this
 * installation there is nothing to confirm a number for.
 */
export const canConfirmPhone = <User extends Reachable>(user: User, notifier: Pick<Notifier, 'smsAvailable'>): user is User & { phone: string } =>
  notifier.smsAvailable && Boolean(user.phone) && !user.phoneVerifiedAt

/** `+4915112345678` → `+49••••••••78`: enough to recognise the number, not to read it. */
export const maskPhone = (phone: string) => `${phone.slice(0, 3)}${'•'.repeat(Math.max(phone.length - 5, 3))}${phone.slice(-2)}`

/** `anna.schmidt@example.com` → `a***@example.com`. */
export const maskEmail = (email: string) => `${email.slice(0, 1)}***${email.slice(email.lastIndexOf('@'))}`
