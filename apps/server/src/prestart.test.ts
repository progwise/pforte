import { describe, expect, it } from 'vitest'
import { generateKeys } from './keys.js'
import { checkSettings } from './prestart.js'

const keys = generateKeys()
const good = {
  DATABASE_URL: 'postgres://pforte:Qm7v3-long-random-password@db:5432/pforte',
  ISSUER: 'https://id.example.com',
  COOKIE_KEYS: keys.cookieKeys,
  JWKS: keys.jwks,
  SMTP_URL: 'smtps://user:password@mail.example.com:465',
  MAIL_FROM: 'pforte <no-reply@example.com>',
  NODE_ENV: 'production',
}

describe('checking the settings before a start', () => {
  it('accepts what a production start needs', () => {
    expect(checkSettings(good).issuer).toBe('https://id.example.com')
  })

  it('says what is missing', () => {
    expect(() => checkSettings({ ...good, COOKIE_KEYS: undefined })).toThrow(/COOKIE_KEYS is required/)
    expect(() => checkSettings({ ...good, DATABASE_URL: undefined })).toThrow(/DATABASE_URL is required/)
  })

  it('lists every problem of a production start at once', () => {
    const message = (() => {
      try {
        checkSettings({ ...good, ISSUER: 'http://localhost:3300', DATABASE_URL: 'postgres://pforte:pforte@db/pforte', SMTP_URL: undefined, MAIL_FROM: undefined })
      } catch (error) {
        return (error as Error).message
      }
      return ''
    })()

    expect(message).toContain('will not start in production')
    expect(message).toContain('ISSUER is http://localhost:3300')
    expect(message).toContain('well-known default')
    expect(message).toContain('SMTP_URL and MAIL_FROM are not set')
  })

  it('only warns outside production, which keeps development easy', () => {
    expect(() => checkSettings({ ...good, NODE_ENV: 'development', ISSUER: 'http://localhost:3300', SMTP_URL: undefined, MAIL_FROM: undefined })).not.toThrow()
  })
})
