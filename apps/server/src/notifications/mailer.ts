import { createTransport, type Transporter } from 'nodemailer'
import { NotifierUnavailableError } from './notifier.js'

export interface Mail {
  to: string
  subject: string
  text: string
}

export interface Mailer {
  send(mail: Mail): Promise<void>
}

export interface SmtpSettings {
  /** smtp://user:password@host:587 or smtps://… for TLS from the start. */
  url: string
  /** The sender, e.g. `Example Inc. <no-reply@example.com>`. */
  from: string
}

/**
 * Sends mail through SMTP, which every mail provider offers. Connection problems become a
 * `NotifierUnavailableError` without the server's own message, as that can name the account.
 * `transport` is replaceable for tests.
 */
export const createSmtpMailer = (
  { url, from }: SmtpSettings,
  transport: Transporter = createTransport({ url, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 }),
): Mailer => ({
  async send({ to, subject, text }) {
    try {
      await transport.sendMail({ from, to, subject, text })
    } catch {
      throw new NotifierUnavailableError('The e-mail could not be sent. Check the SMTP settings and that the mail server is reachable.')
    }
  },
})
