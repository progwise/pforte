export const MIN_PASSWORD_LENGTH = 10
export const MAX_PASSWORD_LENGTH = 128

/**
 * What a new password has to be: long enough, not absurdly long (hashing cost), and not the e-mail
 * address. Length matters, composition rules ("one digit, one symbol") do not, and are left out.
 * Returns what is wrong, or undefined.
 */
export const checkPassword = (password: string, email: string) => {
  if ([...password].length < MIN_PASSWORD_LENGTH) return `The password must have at least ${MIN_PASSWORD_LENGTH} characters.`
  if (password.length > MAX_PASSWORD_LENGTH) return `The password must have at most ${MAX_PASSWORD_LENGTH} characters.`
  if (password.toLowerCase() === email.toLowerCase()) return 'The password must not be your e-mail address.'
  return undefined
}
