import { readFileSync } from 'node:fs'
import { type HttpSmsSettings, PLACEHOLDERS, placeholdersIn } from './notifications/sms.js'

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
  /**
   * Whether pforte may call applications on loopback or private network addresses (back-channel
   * logout). Off by default, which protects against server-side request forgery; turn it on when
   * the applications run on the organisation's own network.
   */
  allowPrivateAddresses: boolean
  /** Named in e-mails. */
  organisationName: string
  /** A folder with texts that replace or add to the built-in ones (`locales/<language>.json`). */
  brandingDir?: string
  /** The language of pages and messages when nothing says otherwise. */
  defaultLanguage: string
  /** Whether "Remember this device" is ticked when the code page opens. */
  rememberDeviceDefault: boolean
  /**
   * How many proxies stand between the internet and pforte. The client's address is the one that many
   * steps from the end of X-Forwarded-For. 0 means pforte is reached directly and the header is ignored.
   */
  trustProxy: number
  /** How to send e-mail. Without it, codes and links cannot be sent (development writes them to the log). */
  mail?: { smtpUrl: string; from: string }
  /** How to send SMS. Without it, codes go by e-mail only. */
  sms?: HttpSmsSettings
  /** Where times are shown in the administration: an IANA time zone such as `Europe/Berlin`. */
  timeZone: string
  /** If pforte has no administrator, this address becomes one and is mailed the link to choose a password. */
  bootstrapAdminEmail?: string
  /** Whether this is a production start (`NODE_ENV=production`), where weak secrets stop it (see `security/startup-checks.ts`). */
  production: boolean
  /** Sign-in events (`login.*`) older than this many days are deleted; 0 keeps them. Administrative events are always kept. */
  loginAuditRetentionDays: number
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

const parseMail = (env: Env) => {
  const smtpUrl = readSecret(env, 'SMTP_URL')
  const from = env.MAIL_FROM?.trim()
  if (!smtpUrl) {
    if (from) throw new Error('MAIL_FROM is set, but SMTP_URL (or SMTP_URL_FILE) is not')
    return undefined
  }
  if (!from) throw new Error('MAIL_FROM is required when SMTP_URL is set, e.g. "Example Inc. <no-reply@example.com>"')
  if (!/^smtps?:\/\//.test(smtpUrl)) throw new Error('SMTP_URL must start with smtp:// or smtps://')
  return { smtpUrl, from }
}

const CONTENT_TYPES = { json: 'application/json', form: 'application/x-www-form-urlencoded' } as const

const parseSms = (env: Env): HttpSmsSettings | undefined => {
  const provider = env.SMS_PROVIDER?.trim()
  if (!provider) return undefined
  if (provider !== 'http') throw new Error('SMS_PROVIDER must be "http"; other providers are set up with SMS_URL, SMS_HEADERS and SMS_BODY')

  const url = env.SMS_URL?.trim()
  if (!url) throw new Error('SMS_URL is required when SMS_PROVIDER is set')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`SMS_URL must be an absolute URL, got "${url}"`)
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) {
    throw new Error('SMS_URL must use https, as it carries your provider credentials (http is only allowed for localhost)')
  }

  const method = (env.SMS_METHOD?.trim().toUpperCase() || 'POST') as string
  if (method !== 'POST' && method !== 'PUT') throw new Error('SMS_METHOD must be POST or PUT')

  const contentTypeName = env.SMS_CONTENT_TYPE?.trim() || 'json'
  if (!(contentTypeName in CONTENT_TYPES)) throw new Error('SMS_CONTENT_TYPE must be "json" or "form"')

  const body = env.SMS_BODY
  if (!body) throw new Error('SMS_BODY is required when SMS_PROVIDER is set, e.g. {"to":"{{to}}","text":"{{text}}"}')
  const used = placeholdersIn(body)
  const unknown = used.filter((name) => !(PLACEHOLDERS as readonly string[]).includes(name))
  if (unknown.length > 0) throw new Error(`SMS_BODY uses unknown placeholders: ${unknown.map((name) => `{{${name}}}`).join(', ')}. Known: ${PLACEHOLDERS.map((name) => `{{${name}}}`).join(', ')}`)
  if (!used.includes('to') || !used.includes('text')) throw new Error('SMS_BODY must contain {{to}} and {{text}}')
  const from = env.SMS_FROM?.trim() || undefined
  if (used.includes('from') && !from) throw new Error('SMS_BODY uses {{from}}, so SMS_FROM is required')

  let headers: Record<string, string> = {}
  const rawHeaders = readSecret(env, 'SMS_HEADERS')
  if (rawHeaders) {
    try {
      const parsedHeaders: unknown = JSON.parse(rawHeaders)
      if (!parsedHeaders || typeof parsedHeaders !== 'object' || Array.isArray(parsedHeaders) || Object.values(parsedHeaders).some((value) => typeof value !== 'string')) {
        throw new Error('not an object of strings')
      }
      headers = parsedHeaders as Record<string, string>
    } catch {
      throw new Error('SMS_HEADERS must be a JSON object with string values, e.g. {"Authorization":"Basic …"}')
    }
  }

  let successPattern: RegExp | undefined
  if (env.SMS_SUCCESS_PATTERN) {
    try {
      successPattern = new RegExp(env.SMS_SUCCESS_PATTERN)
    } catch {
      throw new Error('SMS_SUCCESS_PATTERN must be a valid regular expression')
    }
  }

  return { url, method, headers, contentType: CONTENT_TYPES[contentTypeName as keyof typeof CONTENT_TYPES], body, from, successPattern }
}

const parseTrustProxy = (value: string | undefined) => {
  if (value === undefined || value.trim() === '') return 0
  const hops = Number(value)
  if (!Number.isInteger(hops) || hops < 0 || hops > 10) {
    throw new Error('TRUST_PROXY must be the number of proxies in front of pforte (0 to 10), e.g. 1 behind a tunnel or a load balancer')
  }
  return hops
}

const parseRetention = (value: string | undefined) => {
  if (value === undefined || value.trim() === '') return 180
  const days = Number(value)
  if (!Number.isInteger(days) || days < 0 || days > 3650) {
    throw new Error('AUDIT_LOGIN_RETENTION_DAYS must be a number of days from 1 to 3650, or 0 to keep sign-in events for ever')
  }
  return days
}

const parseBootstrapAdmin = (value: string | undefined) => {
  const email = value?.trim().toLowerCase()
  if (!email) return undefined
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`BOOTSTRAP_ADMIN_EMAIL must be an e-mail address, got "${value}"`)
  return email
}

const parseTimeZone = (value: string | undefined) => {
  const zone = value?.trim() || 'UTC'
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
  } catch {
    throw new Error(`TIME_ZONE must be a time zone such as Europe/Berlin or UTC, got "${value}"`)
  }
  return zone
}

export const loadConfig = (env: Env = process.env): Config => ({
  port: Number(env.PORT ?? 3300),
  databaseUrl: requireSecret(env, 'DATABASE_URL'),
  issuer: parseIssuer(requireSecret(env, 'ISSUER')),
  cookieKeys: parseCookieKeys(requireSecret(env, 'COOKIE_KEYS', '; generate them with `pforte keys`, or run pnpm dev:keys for development')),
  jwks: parseJwks(requireSecret(env, 'JWKS', '; generate them with `pforte keys`, or run pnpm dev:keys for development')),
  allowPrivateAddresses: env.OUTBOUND_ALLOW_PRIVATE_ADDRESSES === 'true',
  organisationName: env.ORGANISATION_NAME?.trim() || 'pforte',
  brandingDir: env.BRANDING_DIR?.trim() || undefined,
  defaultLanguage: env.DEFAULT_LANGUAGE?.trim().toLowerCase() || 'en',
  rememberDeviceDefault: env.REMEMBER_DEVICE_DEFAULT === 'true',
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
  loginAuditRetentionDays: parseRetention(env.AUDIT_LOGIN_RETENTION_DAYS),
  production: env.NODE_ENV === 'production',
  bootstrapAdminEmail: parseBootstrapAdmin(env.BOOTSTRAP_ADMIN_EMAIL),
  timeZone: parseTimeZone(env.TIME_ZONE),
  mail: parseMail(env),
  sms: parseSms(env),
})
