/**
 * How strongly the user was authenticated, as `acr` (class) and `amr` (methods, RFC 8176) in the ID
 * token, so applications can tell whether a second factor was used.
 */
export const ACR_PASSWORD = 'urn:pforte:acr:pwd'
export const ACR_SECOND_FACTOR = 'urn:pforte:acr:mfa'

/**
 * What a sign-in with a passkey is: the person holds the key (`pop`, proof of possession) and their device
 * checked them with face, finger or PIN before it used it, which makes two factors in one step (`mfa`). The
 * device does not say which of the three it was.
 */
export const passkeyAssurance = { acr: ACR_SECOND_FACTOR, amr: ['pop', 'mfa'] }

/** What the user did to sign in with a code from the given channel. */
export const secondFactorAssurance = (channel: 'email' | 'sms') => ({
  acr: ACR_SECOND_FACTOR,
  amr: channel === 'sms' ? ['pwd', 'sms'] : ['pwd', 'otp'],
})
