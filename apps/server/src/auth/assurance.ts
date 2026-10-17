/**
 * How strongly the user was authenticated, as `acr` (class) and `amr` (methods, RFC 8176) in the ID
 * token, so applications can tell whether a second factor was used.
 */
export const ACR_PASSWORD = 'urn:pforte:acr:pwd'
export const ACR_SECOND_FACTOR = 'urn:pforte:acr:mfa'

/** What the user did to sign in with a code from the given channel. */
export const secondFactorAssurance = (channel: 'email' | 'sms') => ({
  acr: ACR_SECOND_FACTOR,
  amr: channel === 'sms' ? ['pwd', 'sms'] : ['pwd', 'otp'],
})
