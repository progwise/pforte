import { describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { redactUrl } from './log-redaction.js'

describe('the address of a request in the log', () => {
  it('keeps what is not secret and hides what is', () => {
    expect(redactUrl('/activate?token=abc123&lang=de')).toBe('/activate?token=REDACTED&lang=de')
    expect(redactUrl('/reset/code?email=anna%40example.com&lang=fr')).toBe('/reset/code?email=REDACTED&lang=fr')
    expect(redactUrl('/auth?client_id=web&login_hint=a%40b.c&id_token_hint=eyJhbGciOi&state=s')).toBe(
      '/auth?client_id=web&login_hint=REDACTED&id_token_hint=REDACTED&state=s',
    )
  })

  it('leaves an address without a query, or without anything secret, as it is', () => {
    expect(redactUrl('/health')).toBe('/health')
    expect(redactUrl('/auth?client_id=web&scope=openid')).toBe('/auth?client_id=web&scope=openid')
    expect(redactUrl('/x?')).toBe('/x?')
  })

  it('hides every value of a parameter that is given twice', () => {
    expect(redactUrl('/activate?token=one&token=two')).not.toMatch(/one|two/)
  })

  it('writes no secret to the log of a running app', async () => {
    const lines: string[] = []
    const app = buildApp({ getDatabaseTime: async () => new Date(), logStream: { write: (line) => void lines.push(line) } })
    app.get('/activate', async () => 'ok')
    await app.ready()

    await app.inject({ url: '/activate?token=SECRET-TOKEN-1234&email=anna%40example.com' })

    const log = lines.join('')
    expect(log).toContain('/activate?token=REDACTED&email=REDACTED')
    expect(log).not.toContain('SECRET-TOKEN-1234')
    expect(log).not.toContain('anna')
  })
})
