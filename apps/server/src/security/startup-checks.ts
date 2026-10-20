import { verify } from '@node-rs/argon2'
import type { Database } from '@progwise/pforte-db'
import { listClients } from '@progwise/pforte-db/admin'
import { findUserByEmail } from '@progwise/pforte-db/users'
import type { Config } from '../config.js'

/** Passwords of databases that people leave as they were. */
const DEFAULT_DATABASE_PASSWORDS = ['', 'pforte', 'postgres', 'password', 'admin', 'secret', 'changeme', 'root', '1234', '123456']
const MIN_DISTINCT_CHARACTERS = 12
const MIN_RSA_BITS = 2048

const base64urlBits = (value: unknown) => (typeof value === 'string' ? Buffer.from(value, 'base64url').length * 8 : 0)

/**
 * What is wrong with the configuration for a production start. Nothing here is a secret's value: the
 * messages say what to change, not what the secret is.
 */
export const checkConfig = (config: Config) => {
  const problems: string[] = []

  if (!config.issuer.startsWith('https:')) {
    problems.push(`ISSUER is ${config.issuer}. In production it must be an https address: passwords and tokens travel to it.`)
  }

  try {
    const password = decodeURIComponent(new URL(config.databaseUrl).password)
    if (DEFAULT_DATABASE_PASSWORDS.includes(password.toLowerCase())) {
      problems.push('The password in DATABASE_URL is empty or a well-known default. Give the database a long random password.')
    }
  } catch {
    problems.push('DATABASE_URL is not a valid address.')
  }

  config.cookieKeys.forEach((key, index) => {
    if (new Set(key).size < MIN_DISTINCT_CHARACTERS) {
      problems.push(`Cookie key ${index + 1} of COOKIE_KEYS looks guessable (fewer than ${MIN_DISTINCT_CHARACTERS} different characters). Generate keys with: node scripts/dev-keys.mjs --force, or openssl rand -base64 48.`)
    }
  })

  for (const key of config.jwks.keys) {
    if (key.kty === 'RSA' && base64urlBits(key.n) < MIN_RSA_BITS) {
      problems.push(`The signing key "${key.kid}" in JWKS is an RSA key of less than ${MIN_RSA_BITS} bits. Use at least ${MIN_RSA_BITS}.`)
    }
    if (key.kty === 'EC' && !['P-256', 'P-384', 'P-521'].includes(String(key.crv))) {
      problems.push(`The signing key "${key.kid}" in JWKS uses the curve ${String(key.crv)}. Use P-256, P-384 or P-521.`)
    }
    if (key.kty !== 'RSA' && key.kty !== 'EC') {
      problems.push(`The signing key "${key.kid}" in JWKS has type ${key.kty}. Use an RSA or EC key.`)
    }
  }

  if (!config.mail) {
    problems.push('SMTP_URL and MAIL_FROM are not set. Every sign-in needs a code by e-mail (or SMS), so nobody could sign in. See docs/sms.md and .env.example.')
  }

  return problems
}

const DEVELOPMENT_CLIENT_SECRET = 'dev-secret'
const DEVELOPMENT_PASSWORD = 'dev-password'

/**
 * What the development seed left in the database: clients with the secret `dev-secret` and users at
 * example.com (an address nobody can have) with the password `dev-password`. In production either one is a
 * door that everybody knows.
 */
export const checkDevelopmentLeftovers = async (db: Database) => {
  const problems: string[] = []

  for (const client of await listClients(db)) {
    if (!client.secretHash) continue
    const matches = await verify(client.secretHash, DEVELOPMENT_CLIENT_SECRET).catch(() => false)
    if (matches) {
      problems.push(
        `The client "${client.clientId}" still has the development secret. Change it with POST /admin/clients/${client.clientId}/rotate-secret, or delete the client.`,
      )
    }
  }

  const { rows } = await db.$client.query<{ email: string }>(`select email from users where email like '%@example.com' and password_hash is not null order by email limit 50`)
  const withDevelopmentPassword: string[] = []
  for (const { email } of rows) {
    const user = await findUserByEmail(db, email)
    if (user?.passwordHash && (await verify(user.passwordHash, DEVELOPMENT_PASSWORD).catch(() => false))) withDevelopmentPassword.push(email)
  }
  if (withDevelopmentPassword.length > 0) {
    const shown = withDevelopmentPassword.slice(0, 3).join(', ')
    const more = withDevelopmentPassword.length > 3 ? ` and ${withDevelopmentPassword.length - 3} more` : ''
    problems.push(`${withDevelopmentPassword.length} user(s) still have the development password (${shown}${more}). They come from the seed: delete them or give them other passwords.`)
  }

  return problems
}

/** The message that stops a production start: every problem, so they can be fixed in one go. */
export const startupFailure = (problems: string[]) =>
  `pforte will not start in production (NODE_ENV=production) because:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`
