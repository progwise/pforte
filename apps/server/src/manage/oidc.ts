import { createHash, randomBytes } from 'node:crypto'

const random = (bytes: number) => randomBytes(bytes).toString('base64url')

/** What a sign-in of the UI has to remember between leaving for pforte's login page and coming back. */
export interface LoginState {
  state: string
  nonce: string
  verifier: string
  /** Where to go afterwards: an address inside the administration. */
  next: string
  /** Set when a weaker sign-in was found and a new one, with a code, was asked for. */
  forced: boolean
  expiresAt: number
}

export const newLogin = (next: string, forced: boolean, now = Date.now()): LoginState => ({
  state: random(16),
  nonce: random(16),
  verifier: random(32),
  next,
  forced,
  expiresAt: now + 10 * 60 * 1000,
})

/** PKCE: the code can only be exchanged by whoever holds the verifier, which never left the server. */
export const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

/**
 * Where to go after signing in: an address inside the administration, nothing else, so the sign-in cannot be
 * used to send somebody to another site.
 */
export const safeNext = (next: unknown, base: string) => {
  if (typeof next !== 'string' || !next.startsWith(`${base}`) || next.startsWith('//') || /[\\\s]/.test(next)) return base
  if (next !== base && !/^\/manage[/?]/.test(next)) return base
  return next
}

export interface IdTokenClaims {
  iss?: string
  aud?: string | string[]
  nonce?: string
  exp?: number
  acr?: string
  sub?: string
  name?: string
  email?: string
}

/**
 * The claims of an ID token received directly from pforte's own token endpoint. Its signature is not checked: it
 * was not passed through a browser or any network, so nobody could have changed it. What is checked is that it was
 * meant for this sign-in.
 */
export const readIdToken = (idToken: unknown): IdTokenClaims | undefined => {
  if (typeof idToken !== 'string') return undefined
  const payload = idToken.split('.')[1]
  if (!payload) return undefined
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()) as IdTokenClaims
  } catch {
    return undefined
  }
}

export const isForThisSignIn = (claims: IdTokenClaims, expected: { issuer: string; clientId: string; nonce: string }, now = Date.now()) =>
  claims.iss === expected.issuer &&
  [claims.aud].flat().includes(expected.clientId) &&
  claims.nonce === expected.nonce &&
  typeof claims.exp === 'number' &&
  claims.exp * 1000 > now
