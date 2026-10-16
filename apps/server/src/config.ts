import { readFileSync } from 'node:fs'

export interface Jwk {
  kid: string
  kty: string
  [parameter: string]: unknown
}

export interface Config {
  port: number
  databaseUrl: string
  /** Public URL of this service, the `iss` of all tokens. */
  issuer: string
  /** Keys used to sign cookies. The first key signs, all keys verify (rotation). */
  cookieKeys: string[]
  /** Private signing keys. The first key signs tokens, all keys are published and verify (rotation). */
  jwks: { keys: Jwk[] }
}

type Env = Record<string, string | undefined>

/**
 * Reads a secret from `NAME`, or from the file named by `NAME_FILE` (for mounted secrets).
 * Setting both is an error, so it is never unclear which one is in effect.
 */
export const readSecret = (env: Env, name: string, readFile = readFileSync): string | undefined => {
  const value = env[name]
  const file = env[`${name}_FILE`]
  if (value && file) {
    throw new Error(`Set either ${name} or ${name}_FILE, not both`)
  }
  if (file) {
    return readFile(file, 'utf8').trim()
  }
  return value
}

const requireSecret = (env: Env, name: string, hint = '') => {
  const value = readSecret(env, name)
  if (!value) {
    throw new Error(`${name} is required (or ${name}_FILE)${hint}`)
  }
  return value
}

const parseIssuer = (value: string) => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`ISSUER must be an absolute URL, got "${value}"`)
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    throw new Error('ISSUER must use https (http is only allowed for localhost)')
  }
  if (url.search || url.hash) {
    throw new Error('ISSUER must not contain a query or fragment')
  }
  return url.toString().replace(/\/$/, '')
}

const MIN_COOKIE_KEY_LENGTH = 32

const parseCookieKeys = (value: string) => {
  const keys = value
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)
  if (keys.length === 0) {
    throw new Error('COOKIE_KEYS must contain at least one key')
  }
  if (keys.some((key) => key.length < MIN_COOKIE_KEY_LENGTH)) {
    throw new Error(`Every key in COOKIE_KEYS must be at least ${MIN_COOKIE_KEY_LENGTH} characters long`)
  }
  return keys
}

const parseJwks = (value: string) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('JWKS must be a JSON object like {"keys":[…]}')
  }
  const keys = (parsed as { keys?: unknown })?.keys
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('JWKS must contain at least one key')
  }
  for (const key of keys as Partial<Jwk>[]) {
    if (!key.kid || !key.kty) {
      throw new Error('Every key in JWKS needs a "kid" and a "kty"')
    }
    // RSA and EC private keys carry "d"; a key without it cannot sign.
    if (!('d' in key)) {
      throw new Error(`Key "${key.kid}" in JWKS is not a private key`)
    }
  }
  return { keys: keys as Jwk[] }
}

export const loadConfig = (env: Env = process.env): Config => ({
  port: Number(env.PORT ?? 3300),
  databaseUrl: requireSecret(env, 'DATABASE_URL'),
  issuer: parseIssuer(requireSecret(env, 'ISSUER')),
  cookieKeys: parseCookieKeys(requireSecret(env, 'COOKIE_KEYS', '; run pnpm dev:keys for development')),
  jwks: parseJwks(requireSecret(env, 'JWKS', '; run pnpm dev:keys for development')),
})
