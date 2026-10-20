import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Fresh secrets for a new installation: the key that signs cookies, and the key that signs tokens. */
export const generateKeys = () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = privateKey.export({ format: 'jwk' })
  return {
    cookieKeys: randomBytes(48).toString('base64url'),
    jwks: JSON.stringify({ keys: [{ ...jwk, kid: randomBytes(8).toString('hex'), alg: 'RS256', use: 'sig' }] }),
  }
}

/**
 * The keys as lines for an environment file. Without quotes: `docker run --env-file` keeps quotes as part of the value, and
 * Docker Compose reads these lines as they are (base64url and JSON have no characters that need protecting).
 */
export const keysAsEnvironment = ({ cookieKeys, jwks }: ReturnType<typeof generateKeys>) => `COOKIE_KEYS=${cookieKeys}\nJWKS=${jwks}\n`

export const KEY_FILES = { cookieKeys: 'cookie_keys', jwks: 'jwks.json' } as const

/**
 * Writes the keys as files only their owner can read, for `COOKIE_KEYS_FILE` and `JWKS_FILE`. Existing files are
 * never replaced unless `force` is set: new keys would sign out everybody, and old tokens could no longer be checked.
 */
export const writeKeyFiles = (directory: string, keys: ReturnType<typeof generateKeys>, { force = false }: { force?: boolean } = {}) => {
  const files = { [join(directory, KEY_FILES.cookieKeys)]: `${keys.cookieKeys}\n`, [join(directory, KEY_FILES.jwks)]: `${keys.jwks}\n` }
  const existing = Object.keys(files).filter((file) => existsSync(file))
  if (existing.length > 0 && !force) {
    throw new Error(`${existing.join(' and ')} already exist${existing.length === 1 ? 's' : ''}. New keys would sign everybody out and invalidate every token; add --force if that is what you want.`)
  }
  mkdirSync(directory, { recursive: true })
  for (const [file, content] of Object.entries(files)) writeFileSync(file, content, { mode: 0o600 })
  return Object.keys(files)
}
