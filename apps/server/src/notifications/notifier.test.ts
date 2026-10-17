import { describe, expect, it } from 'vitest'
import { createLogNotifier, NotifierUnavailableError } from './notifier.js'

const user = { id: 'u1', email: 'ada@example.com', firstName: 'Ada', lastName: 'L', language: 'en' }
const link = { url: 'https://id.example.com/activate?token=secret-token', expiresAt: new Date('2026-12-01T00:00:00Z') }

describe('development notifier', () => {
  it('writes the activation link and the reset request to the log', async () => {
    const lines: string[] = []
    const notifier = createLogNotifier({ log: (message) => lines.push(message), production: false })

    await notifier.sendActivationLink(user, link)
    await notifier.requestPasswordReset(user)

    expect(lines[0]).toContain('ada@example.com')
    expect(lines[0]).toContain(link.url)
    expect(lines[1]).toContain('Password reset requested for ada@example.com')
  })

  it('refuses in production and keeps secrets out of the log', async () => {
    const lines: string[] = []
    const notifier = createLogNotifier({ log: (message) => lines.push(message), production: true })

    await expect(notifier.sendActivationLink(user, link)).rejects.toBeInstanceOf(NotifierUnavailableError)
    await expect(notifier.requestPasswordReset(user)).rejects.toBeInstanceOf(NotifierUnavailableError)
    expect(lines).toEqual([])
  })
})
