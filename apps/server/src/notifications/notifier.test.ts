import { describe, expect, it } from 'vitest'
import { createI18n } from '../i18n/index.js'
import { createMailNotifier, createLogNotifier, NotifierUnavailableError } from './notifier.js'
import { createSmtpMailer, type Mail } from './mailer.js'
import { createTransport } from 'nodemailer'

const user = { id: 'u1', email: 'ada@example.com', firstName: 'Ada', lastName: 'L', language: 'en', phone: '+4915112345678' }
const link = { url: 'https://id.example.com/activate?token=secret-token', expiresAt: new Date('2026-12-01T00:00:00Z') }

describe('development notifier', () => {
  it('writes the activation link and the reset request to the log', async () => {
    const lines: string[] = []
    const notifier = createLogNotifier({ log: (message) => lines.push(message), production: false })

    await notifier.sendActivationLink(user, link)
    await notifier.sendResetCode(user, { code: '654321', channel: 'email' as const, expiresAt: new Date('2030-01-01T10:10:00Z'), url: 'https://id.example.com/reset/code?email=ada%40example.com' })

    expect(lines[0]).toContain('ada@example.com')
    expect(lines[0]).toContain(link.url)
    expect(lines[1]).toContain('Password reset code for ada@example.com')
    expect(lines[1]).toContain('654321')
  })

  it('refuses in production and keeps secrets out of the log', async () => {
    const lines: string[] = []
    const notifier = createLogNotifier({ log: (message) => lines.push(message), production: true })

    await expect(notifier.sendActivationLink(user, link)).rejects.toBeInstanceOf(NotifierUnavailableError)
    await expect(notifier.sendResetCode(user, { code: '1', expiresAt: new Date(), url: 'x', channel: 'email' as const })).rejects.toBeInstanceOf(NotifierUnavailableError)
    expect(lines).toEqual([])
  })
})

describe('development notifier codes', () => {
  it('writes the sign-in code to the log, but never in production', async () => {
    const lines: string[] = []
    const expiresAt = new Date('2030-01-01T10:10:00Z')
    await createLogNotifier({ log: (message) => lines.push(message), production: false }).sendLoginCode(user, { code: '123456', expiresAt, channel: 'email' as const })
    expect(lines[0]).toContain('123456')

    const quiet: string[] = []
    await expect(createLogNotifier({ log: (message) => quiet.push(message), production: true }).sendLoginCode(user, { code: '123456', expiresAt, channel: 'email' as const })).rejects.toBeInstanceOf(NotifierUnavailableError)
    expect(quiet).toEqual([])
  })
})

describe('mail notifier', () => {
  const sent: Mail[] = []
  const notifier = createMailNotifier({ mailer: { send: async (mail) => void sent.push(mail) }, organisation: 'Example Inc.', i18n: createI18n() })

  it('sends the sign-in code in the language of the user', async () => {
    sent.length = 0
    const expiresAt = new Date(Date.now() + 10 * 60_000)
    await notifier.sendLoginCode(user, { code: '042917', expiresAt, channel: 'email' as const })
    await notifier.sendLoginCode({ ...user, language: 'de' }, { code: '042917', expiresAt, channel: 'email' as const })
    expect(sent[0]).toMatchObject({ to: 'ada@example.com', subject: 'Your sign-in code for Example Inc.' })
    expect(sent[0]!.text).toContain('042917')
    expect(sent[0]!.text).toContain('valid for 10 minutes')
    expect(sent[1]!.subject).toBe('Ihr Anmeldecode für Example Inc.')
    expect(sent[1]!.text).toContain('10 Minuten')
  })

  it('falls back to English for other languages', async () => {
    sent.length = 0
    await notifier.sendLoginCode({ ...user, language: 'pt' }, { code: '111111', expiresAt: new Date(Date.now() + 600_000), channel: 'email' as const })
    expect(sent[0]!.subject).toContain('Your sign-in code')
  })

  it('sends the activation link', async () => {
    sent.length = 0
    await notifier.sendActivationLink(user, { url: link.url, expiresAt: new Date(Date.now() + 72 * 3_600_000) })
    expect(sent[0]!.text).toContain(link.url)
    expect(sent[0]!.text).toContain('72 hours')
  })

  it('names the application in the activation e-mail when there is one, in the language of the user', async () => {
    sent.length = 0
    const base = { url: link.url, expiresAt: new Date(Date.now() + 72 * 3_600_000), applicationName: 'Partner Portal' }
    await notifier.sendActivationLink(user, base)
    await notifier.sendActivationLink({ ...user, language: 'de' }, base)
    expect(sent[0]!.subject).toBe('Activate your account for Partner Portal')
    expect(sent[0]!.text).toContain('to sign in to Partner Portal')
    expect(sent[0]!.text).toContain(link.url)
    expect(sent[1]!.subject).toBe('Aktivieren Sie Ihr Konto für Partner Portal')
  })

  it('sends the password reset code with the page to enter it, in the language of the user', async () => {
    sent.length = 0
    const reset = { code: '654321', channel: 'email' as const, expiresAt: new Date(Date.now() + 10 * 60_000), url: 'https://id.example.com/reset/code?email=ada%40example.com' }
    await notifier.sendResetCode(user, reset)
    await notifier.sendResetCode({ ...user, language: 'de' }, reset)
    expect(sent[0]).toMatchObject({ to: 'ada@example.com', subject: 'Choose a new password for Example Inc.' })
    expect(sent[0]!.text).toContain('654321')
    expect(sent[0]!.text).toContain(reset.url)
    expect(sent[1]!.subject).toBe('Neues Passwort für Example Inc.')
  })
})

describe('mail notifier with SMS', () => {
  const mails: Mail[] = []
  const texts: { to: string; text: string }[] = []
  const notifier = createMailNotifier({
    mailer: { send: async (mail) => void mails.push(mail) },
    sms: { send: async (sms) => void texts.push(sms) },
    organisation: 'Example Inc.',
    i18n: createI18n(),
  })
  const expiresAt = () => new Date(Date.now() + 10 * 60_000)

  it('says it can send SMS only when a sender is configured', () => {
    expect(notifier.smsAvailable).toBe(true)
    expect(createMailNotifier({ mailer: { send: async () => {} }, organisation: 'x', i18n: createI18n() }).smsAvailable).toBe(false)
  })

  it('sends the sign-in code as a short text with the code first, to the phone number', async () => {
    mails.length = 0
    texts.length = 0
    await notifier.sendLoginCode(user, { code: '042917', expiresAt: expiresAt(), channel: 'sms' })
    await notifier.sendLoginCode({ ...user, language: 'de' }, { code: '042917', expiresAt: expiresAt(), channel: 'sms' })
    expect(mails).toEqual([])
    expect(texts[0]).toEqual({ to: '+4915112345678', text: '042917 is your sign-in code for Example Inc.. Valid for 10 minutes. Do not share it.' })
    expect(texts[1]!.text).toBe('042917 ist Ihr Anmeldecode für Example Inc.. Gültig 10 Minuten. Nicht weitergeben.')
    expect(texts.every(({ text }) => text.length <= 160)).toBe(true)
  })

  it('sends reset and phone codes by SMS', async () => {
    texts.length = 0
    await notifier.sendResetCode(user, { code: '111222', expiresAt: expiresAt(), channel: 'sms', url: 'https://id.example.com/reset/code?email=a' })
    await notifier.sendPhoneCode(user, { code: '333444', expiresAt: expiresAt() })
    expect(texts[0]!.text).toContain('111222')
    expect(texts[0]!.text).toContain('https://id.example.com/reset/code?email=a')
    expect(texts[1]!.text).toContain('333444')
    expect(texts[1]!.text).toContain('confirm this phone number')
  })

  it('cannot send an SMS to a user without a number, or without a configured sender', async () => {
    await expect(notifier.sendLoginCode({ ...user, phone: null }, { code: '1', expiresAt: expiresAt(), channel: 'sms' })).rejects.toBeInstanceOf(NotifierUnavailableError)
    const mailOnly = createMailNotifier({ mailer: { send: async () => {} }, organisation: 'x', i18n: createI18n() })
    await expect(mailOnly.sendPhoneCode(user, { code: '1', expiresAt: expiresAt() })).rejects.toBeInstanceOf(NotifierUnavailableError)
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
