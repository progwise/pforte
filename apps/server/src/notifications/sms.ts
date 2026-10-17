import { NotifierUnavailableError } from './notifier.js'

export interface Sms {
  /** E.164, e.g. +4915112345678. */
  to: string
  text: string
}

export interface SmsSender {
  send(sms: Sms): Promise<void>
}

export const PLACEHOLDERS = ['to', 'text', 'from'] as const
export type SmsContentType = 'application/json' | 'application/x-www-form-urlencoded'

export interface HttpSmsSettings {
  url: string
  method: 'POST' | 'PUT'
  /** Sent as given; this is where the provider's credentials go. */
  headers: Record<string, string>
  contentType: SmsContentType
  /** The request body with `{{to}}`, `{{text}}` and `{{from}}` where the values belong. */
  body: string
  from?: string
  /**
   * For providers that answer 200 even when the message was refused and only say so in the body: the
   * answer counts as success only if its body matches.
   */
  successPattern?: RegExp
}

/** The placeholders a body template uses, and anything that is not one of ours. */
export const placeholdersIn = (template: string) => [...template.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)].map((match) => match[1]!)

/**
 * Puts the values into the template, encoded for where they land, so a message can never break out of
 * its field: JSON-escaped for a JSON body, percent-encoded for a form body.
 */
export const renderBody = (template: string, values: Record<(typeof PLACEHOLDERS)[number], string>, contentType: SmsContentType) =>
  template.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (_match, name: string) => {
    const value = values[name as keyof typeof values] ?? ''
    return contentType === 'application/json' ? JSON.stringify(value).slice(1, -1) : encodeURIComponent(value)
  })

export interface HttpSmsOptions {
  fetchImpl?: typeof fetch
  sleep?: (milliseconds: number) => Promise<void>
  /** Pauses before each retry. One retry by default: a code sent twice does no harm, a code never sent does. */
  retryDelaysMs?: number[]
  timeoutMs?: number
}

/**
 * Sends SMS through any provider with an HTTP API: the request is built from configuration, so
 * supporting another provider means writing settings, not code. Success is a 2xx answer, or, for
 * providers that answer 2xx even when they refuse, a 2xx answer whose body matches. Network errors,
 * 429 and 5xx are tried again once; other answers are not. The provider's answer is never passed on,
 * as it can contain the phone number and the code.
 */
export const createHttpSmsSender = (
  settings: HttpSmsSettings,
  {
    fetchImpl = fetch,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    retryDelaysMs = [500],
    timeoutMs = 10_000,
  }: HttpSmsOptions = {},
): SmsSender => ({
  async send({ to, text }) {
    const body = renderBody(settings.body, { to, text, from: settings.from ?? '' }, settings.contentType)
    for (let attempt = 0; ; attempt++) {
      let retryable = true
      try {
        const response = await fetchImpl(settings.url, {
          method: settings.method,
          headers: { ...settings.headers, 'content-type': settings.contentType },
          body,
          // A redirect would take the credentials in the headers somewhere else; it is treated as a refusal.
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (response.ok) {
          if (!settings.successPattern || settings.successPattern.test(await response.text())) return
          throw new NotifierUnavailableError('The SMS provider did not accept the message. Check the SMS settings and your account with the provider.')
        }
        retryable = response.status === 429 || response.status >= 500
        if (!retryable) throw new NotifierUnavailableError(`The SMS provider refused the message (HTTP ${response.status}). Check the SMS settings.`)
      } catch (error) {
        if (error instanceof NotifierUnavailableError) throw error
      }
      const delay = retryDelaysMs[attempt]
      if (!retryable || delay === undefined) {
        throw new NotifierUnavailableError('The SMS could not be sent. Check the SMS settings and that the provider is reachable.')
      }
      await sleep(delay)
    }
  },
})
