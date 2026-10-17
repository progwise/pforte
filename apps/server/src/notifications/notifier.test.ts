import { describe, expect, it } from 'vitest'
import { createMailNotifier, createLogNotifier, NotifierUnavailableError } from './notifier.js'
import { createSmtpMailer, type Mail } from './mailer.js'
import { createTransport } from 'nodemailer'

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

describe('development notifier codes', () => {
  it('writes the sign-in code to the log, but never in production', async () => {
    const lines: string[] = []
    const expiresAt = new Date('2030-01-01T10:10:00Z')
    await createLogNotifier({ log: (message) => lines.push(message), production: false }).sendLoginCode(user, { code: '123456', expiresAt })
    expect(lines[0]).toContain('123456')

    const quiet: string[] = []
    await expect(createLogNotifier({ log: (message) => quiet.push(message), production: true }).sendLoginCode(user, { code: '123456', expiresAt })).rejects.toBeInstanceOf(NotifierUnavailableError)
    expect(quiet).toEqual([])
  })
})

describe('mail notifier', () => {
  const sent: Mail[] = []
  const notifier = createMailNotifier({ mailer: { send: async (mail) => void sent.push(mail) }, organisation: 'Example Inc.' })

  it('sends the sign-in code in the language of the user', async () => {
    sent.length = 0
    const expiresAt = new Date(Date.now() + 10 * 60_000)
    await notifier.sendLoginCode(user, { code: '042917', expiresAt })
    await notifier.sendLoginCode({ ...user, language: 'de' }, { code: '042917', expiresAt })
    expect(sent[0]).toMatchObject({ to: 'ada@example.com', subject: 'Your sign-in code for Example Inc.' })
    expect(sent[0]!.text).toContain('042917')
    expect(sent[0]!.text).toContain('valid for 10 minutes')
    expect(sent[1]!.subject).toBe('Ihr Anmeldecode für Example Inc.')
    expect(sent[1]!.text).toContain('10 Minuten')
  })

  it('falls back to English for other languages', async () => {
    sent.length = 0
    await notifier.sendLoginCode({ ...user, language: 'fr' }, { code: '111111', expiresAt: new Date(Date.now() + 600_000) })
    expect(sent[0]!.subject).toContain('Your sign-in code')
  })

  it('sends the activation link', async () => {
    sent.length = 0
    await notifier.sendActivationLink(user, { url: link.url, expiresAt: new Date(Date.now() + 72 * 3_600_000) })
    expect(sent[0]!.text).toContain(link.url)
    expect(sent[0]!.text).toContain('72 hours')
  })

  it('does not pretend to reset passwords yet', async () => {
    await expect(notifier.requestPasswordReset(user)).rejects.toBeInstanceOf(NotifierUnavailableError)
  })
})

describe('SMTP mailer', () => {
  it('hands the message to the transport with sender, recipient and text', async () => {
    const transport = createTransport({ jsonTransport: true })
    const sendMail = transport.sendMail.bind(transport)
    let captured: unknown
    transport.sendMail = (async (message: never) => {
      captured = await sendMail(message)
      return captured
    }) as never
    await createSmtpMailer({ url: 'smtp://unused', from: 'Example <no-reply@example.com>' }, transport).send({ to: 'ada@example.com', subject: 'Hi', text: 'Body' })
    const message = JSON.parse((captured as { message: string }).message)
    expect(message).toMatchObject({ subject: 'Hi', text: 'Body', from: { address: 'no-reply@example.com', name: 'Example' }, to: [{ address: 'ada@example.com' }] })
  })

  it('reports an unreachable server without its own message', async () => {
    const transport = createTransport({ host: '127.0.0.1', port: 1, connectionTimeout: 500 })
    const error = await createSmtpMailer({ url: 'smtp://secret-user:secret-pass@127.0.0.1:1', from: 'a@b.c' }, transport)
      .send({ to: 'ada@example.com', subject: 'Hi', text: 'Body' })
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(NotifierUnavailableError)
    expect(error.message).not.toContain('secret')
  })
})
