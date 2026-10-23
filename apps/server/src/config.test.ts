import { describe, expect, it } from 'vitest'
import { loadConfig, readSecret } from './config.js'

const jwks = JSON.stringify({ keys: [{ kid: 'k1', kty: 'RSA', d: 'private' }] })
const validEnv = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  ISSUER: 'http://localhost:3300',
  COOKIE_KEYS: 'a'.repeat(32),
  JWKS: jwks,
}

describe('readSecret', () => {
  it('reads a plain variable', () => {
    expect(readSecret({ NAME: 'value' }, 'NAME')).toBe('value')
  })

  it('reads and trims the file named by NAME_FILE', () => {
    const readFile = () => 'from-file\n'
    expect(readSecret({ NAME_FILE: '/run/secrets/name' }, 'NAME', readFile as never)).toBe('from-file')
  })

  it('rejects NAME and NAME_FILE together', () => {
    expect(() => readSecret({ NAME: 'a', NAME_FILE: '/b' }, 'NAME')).toThrow(/not both/)
  })

  it('returns undefined when neither is set', () => {
    expect(readSecret({}, 'NAME')).toBeUndefined()
  })
})

describe('loadConfig', () => {
  it('loads a valid configuration', () => {
    const config = loadConfig(validEnv)
    expect(config.port).toBe(3300)
    expect(config.issuer).toBe('http://localhost:3300')
    expect(config.cookieKeys).toEqual(['a'.repeat(32)])
    expect(config.jwks.keys[0]?.kid).toBe('k1')
  })

  it('accepts several cookie keys for rotation', () => {
    const config = loadConfig({ ...validEnv, COOKIE_KEYS: `${'a'.repeat(32)}, ${'b'.repeat(32)}` })
    expect(config.cookieKeys).toHaveLength(2)
  })

  it.each(['DATABASE_URL', 'ISSUER', 'COOKIE_KEYS', 'JWKS'])('requires %s', (name) => {
    expect(() => loadConfig({ ...validEnv, [name]: undefined })).toThrow(new RegExp(name))
  })

  it('rejects an http issuer that is not localhost', () => {
    expect(() => loadConfig({ ...validEnv, ISSUER: 'http://id.example.com' })).toThrow(/https/)
  })

  it('accepts an https issuer and strips a trailing slash', () => {
    expect(loadConfig({ ...validEnv, ISSUER: 'https://id.example.com/' }).issuer).toBe('https://id.example.com')
  })

  it('rejects short cookie keys', () => {
    expect(() => loadConfig({ ...validEnv, COOKIE_KEYS: 'too-short' })).toThrow(/at least 32/)
  })

  it('rejects a JWKS without private keys', () => {
    const publicOnly = JSON.stringify({ keys: [{ kid: 'k1', kty: 'RSA', n: 'x', e: 'AQAB' }] })
    expect(() => loadConfig({ ...validEnv, JWKS: publicOnly })).toThrow(/not a private key/)
  })

  it('blocks calls to private addresses unless explicitly allowed', () => {
    expect(loadConfig(validEnv).allowPrivateAddresses).toBe(false)
    expect(loadConfig({ ...validEnv, OUTBOUND_ALLOW_PRIVATE_ADDRESSES: 'true' }).allowPrivateAddresses).toBe(true)
    expect(loadConfig({ ...validEnv, OUTBOUND_ALLOW_PRIVATE_ADDRESSES: 'yes' }).allowPrivateAddresses).toBe(false)
  })

  it('lets people ask for their activation link unless that is switched off', () => {
    expect(loadConfig(validEnv).selfServiceActivation).toBe(true)
    expect(loadConfig({ ...validEnv, SELF_SERVICE_ACTIVATION: 'false' }).selfServiceActivation).toBe(false)
    expect(loadConfig({ ...validEnv, SELF_SERVICE_ACTIVATION: ' False ' }).selfServiceActivation).toBe(false)
    expect(loadConfig({ ...validEnv, SELF_SERVICE_ACTIVATION: 'true' }).selfServiceActivation).toBe(true)
  })

  it('rejects an invalid JWKS', () => {
    expect(() => loadConfig({ ...validEnv, JWKS: 'not json' })).toThrow(/JSON/)
  })
})

describe('mail settings', () => {
  it('has no mail without SMTP_URL', () => {
    const config = loadConfig(validEnv)
    expect(config.mail).toBeUndefined()
    expect(config.organisationName).toBe('pforte')
  })

  it('reads SMTP_URL, MAIL_FROM and the organisation name', () => {
    const config = loadConfig({ ...validEnv, SMTP_URL: 'smtp://u:p@mail.example.com:587', MAIL_FROM: 'Example <no-reply@example.com>', ORGANISATION_NAME: ' Example Inc. ' })
    expect(config.mail).toEqual({ smtpUrl: 'smtp://u:p@mail.example.com:587', from: 'Example <no-reply@example.com>' })
    expect(config.organisationName).toBe('Example Inc.')
  })

  it('needs a sender, a smtp URL and no stray MAIL_FROM', () => {
    expect(() => loadConfig({ ...validEnv, SMTP_URL: 'smtp://mail:25' })).toThrow(/MAIL_FROM is required/)
    expect(() => loadConfig({ ...validEnv, MAIL_FROM: 'a@b.c' })).toThrow(/SMTP_URL/)
    expect(() => loadConfig({ ...validEnv, SMTP_URL: 'http://mail', MAIL_FROM: 'a@b.c' })).toThrow(/smtp:\/\//)
  })
})

describe('SMS settings', () => {
  const sms = { SMS_PROVIDER: 'http', SMS_URL: 'https://api.example.com/sms', SMS_BODY: '{"to":"{{to}}","text":"{{text}}"}' }

  it('has no SMS by default', () => {
    expect(loadConfig(validEnv).sms).toBeUndefined()
  })

  it('reads the request from the environment, with defaults', () => {
    expect(loadConfig({ ...validEnv, ...sms }).sms).toEqual({
      url: 'https://api.example.com/sms',
      method: 'POST',
      headers: {},
      contentType: 'application/json',
      body: sms.SMS_BODY,
      from: undefined,
      successPattern: undefined,
    })
  })

  it('reads headers, form content type and sender; the headers may come from a file', () => {
    const config = loadConfig({
      ...validEnv,
      ...sms,
      SMS_CONTENT_TYPE: 'form',
      SMS_BODY: 'To={{to}}&From={{from}}&Body={{ text }}',
      SMS_FROM: 'pforte',
      SMS_METHOD: 'post',
      SMS_HEADERS: '{"Authorization":"Basic abc"}',
    })
    expect(config.sms).toMatchObject({ contentType: 'application/x-www-form-urlencoded', from: 'pforte', method: 'POST', headers: { Authorization: 'Basic abc' } })
    expect(() => loadConfig({ ...validEnv, ...sms, SMS_HEADERS: '{"A":"1"}', SMS_HEADERS_FILE: '/x' })).toThrow(/not both/)
  })

  it.each([
    [{ SMS_PROVIDER: 'twilio' }, /must be "http"/],
    [{ SMS_URL: '' }, /SMS_URL is required/],
    [{ SMS_URL: 'not a url' }, /absolute URL/],
    [{ SMS_URL: 'http://api.example.com/sms' }, /must use https/],
    [{ SMS_METHOD: 'GET' }, /POST or PUT/],
    [{ SMS_CONTENT_TYPE: 'xml' }, /"json" or "form"/],
    [{ SMS_BODY: '' }, /SMS_BODY is required/],
    [{ SMS_BODY: '{"to":"{{to}}"}' }, /must contain \{\{to\}\} and \{\{text\}\}/],
    [{ SMS_BODY: '{"to":"{{to}}","text":"{{text}}","x":"{{nope}}"}' }, /unknown placeholders: \{\{nope\}\}/],
    [{ SMS_BODY: '{"to":"{{to}}","text":"{{text}}","from":"{{from}}"}' }, /SMS_FROM is required/],
    [{ SMS_SUCCESS_PATTERN: '(' }, /valid regular expression/],
    [{ SMS_HEADERS: '["a"]' }, /JSON object with string values/],
    [{ SMS_HEADERS: '{"a":1}' }, /JSON object with string values/],
  ])('refuses %j', (override, message) => {
    expect(() => loadConfig({ ...validEnv, ...sms, ...override })).toThrow(message)
  })

  it('reads the pattern that an answer has to match', () => {
    expect(loadConfig({ ...validEnv, ...sms, SMS_SUCCESS_PATTERN: '"success":\\s*"100"' }).sms?.successPattern?.test('{"success": "100"}')).toBe(true)
  })

  it('allows plain http for a provider on localhost', () => {
    expect(loadConfig({ ...validEnv, ...sms, SMS_URL: 'http://localhost:9000/sms' }).sms?.url).toBe('http://localhost:9000/sms')
  })
})

describe('language and branding settings', () => {
  it('has sensible defaults', () => {
    expect(loadConfig(validEnv)).toMatchObject({ defaultLanguage: 'en', rememberDeviceDefault: false, brandingDir: undefined })
  })

  it('reads them from the environment', () => {
    expect(loadConfig({ ...validEnv, DEFAULT_LANGUAGE: ' DE ', BRANDING_DIR: ' /branding ', REMEMBER_DEVICE_DEFAULT: 'true' })).toMatchObject({
      defaultLanguage: 'de',
      brandingDir: '/branding',
      rememberDeviceDefault: true,
    })
  })

  it('ticks nothing for any other value', () => {
    expect(loadConfig({ ...validEnv, REMEMBER_DEVICE_DEFAULT: 'yes' }).rememberDeviceDefault).toBe(false)
  })
})

describe('TRUST_PROXY', () => {
  it('is 0 unless set, so X-Forwarded-For is ignored', () => {
    expect(loadConfig(validEnv).trustProxy).toBe(0)
    expect(loadConfig({ ...validEnv, TRUST_PROXY: ' ' }).trustProxy).toBe(0)
  })

  it('is the number of proxies in front of pforte', () => {
    expect(loadConfig({ ...validEnv, TRUST_PROXY: '1' }).trustProxy).toBe(1)
    expect(loadConfig({ ...validEnv, TRUST_PROXY: '2' }).trustProxy).toBe(2)
  })

  it.each(['yes', 'true', '-1', '1.5', '11'])('refuses %s, as it would trust the wrong address', (value) => {
    expect(() => loadConfig({ ...validEnv, TRUST_PROXY: value })).toThrow(/TRUST_PROXY must be the number of proxies/)
  })
})

describe('AUDIT_LOGIN_RETENTION_DAYS', () => {
  it('is 180 days unless set', () => {
    expect(loadConfig(validEnv).loginAuditRetentionDays).toBe(180)
    expect(loadConfig({ ...validEnv, AUDIT_LOGIN_RETENTION_DAYS: ' ' }).loginAuditRetentionDays).toBe(180)
  })

  it('can be changed, and 0 keeps sign-in events for ever', () => {
    expect(loadConfig({ ...validEnv, AUDIT_LOGIN_RETENTION_DAYS: '90' }).loginAuditRetentionDays).toBe(90)
    expect(loadConfig({ ...validEnv, AUDIT_LOGIN_RETENTION_DAYS: '0' }).loginAuditRetentionDays).toBe(0)
  })

  it.each(['forever', '-5', '1.5', '4000'])('refuses %s', (value) => {
    expect(() => loadConfig({ ...validEnv, AUDIT_LOGIN_RETENTION_DAYS: value })).toThrow(/AUDIT_LOGIN_RETENTION_DAYS must be/)
  })
})

describe('BOOTSTRAP_ADMIN_EMAIL', () => {
  it('is not set unless given, and is tidied up when it is', () => {
    expect(loadConfig(validEnv).bootstrapAdminEmail).toBeUndefined()
    expect(loadConfig({ ...validEnv, BOOTSTRAP_ADMIN_EMAIL: ' ' }).bootstrapAdminEmail).toBeUndefined()
    expect(loadConfig({ ...validEnv, BOOTSTRAP_ADMIN_EMAIL: ' Boss@Example.com ' }).bootstrapAdminEmail).toBe('boss@example.com')
  })

  it.each(['boss', 'boss@', '@example.com', 'a b@example.com', 'boss@example'])('refuses %s', (value) => {
    expect(() => loadConfig({ ...validEnv, BOOTSTRAP_ADMIN_EMAIL: value })).toThrow(/BOOTSTRAP_ADMIN_EMAIL must be an e-mail address/)
  })
})

describe('TIME_ZONE', () => {
  it('is UTC unless set', () => {
    expect(loadConfig(validEnv).timeZone).toBe('UTC')
    expect(loadConfig({ ...validEnv, TIME_ZONE: ' ' }).timeZone).toBe('UTC')
  })

  it('takes a time zone', () => {
    expect(loadConfig({ ...validEnv, TIME_ZONE: 'Europe/Berlin' }).timeZone).toBe('Europe/Berlin')
  })

  it.each(['Berlin', 'CET+1', 'Mars/Olympus'])('refuses %s', (value) => {
    expect(() => loadConfig({ ...validEnv, TIME_ZONE: value })).toThrow(/TIME_ZONE must be a time zone/)
  })
})
