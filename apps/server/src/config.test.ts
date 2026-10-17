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
