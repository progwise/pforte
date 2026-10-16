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

  it('rejects an invalid JWKS', () => {
    expect(() => loadConfig({ ...validEnv, JWKS: 'not json' })).toThrow(/JSON/)
  })
})
