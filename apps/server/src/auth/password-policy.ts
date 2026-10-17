import type { MessageKey, Values } from '../i18n/index.js'

export const MIN_PASSWORD_LENGTH = 10
export const MAX_PASSWORD_LENGTH = 128

/**
 * What a new password has to be: long enough, not absurdly long (hashing cost), and not the e-mail
 * address. Length matters, composition rules ("one digit, one symbol") do not, and are left out.
 * Returns the text that says what is wrong, as a key and its values so it can be shown in any language,
 * or undefined.
 */
export const checkPassword = (password: string, email: string): { key: MessageKey; values?: Values } | undefined => {
  if ([...password].length < MIN_PASSWORD_LENGTH) return { key: 'password.tooShort', values: { min: MIN_PASSWORD_LENGTH } }
  if (password.length > MAX_PASSWORD_LENGTH) return { key: 'password.tooLong', values: { max: MAX_PASSWORD_LENGTH } }
  if (password.toLowerCase() === email.toLowerCase()) return { key: 'password.isEmail' }
  return undefined
}
