import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NotifierUnavailableError } from './notifier.js'
import { createHttpSmsSender, type HttpSmsSettings, placeholdersIn, renderBody } from './sms.js'

describe('body templates', () => {
  it('finds the placeholders, with or without spaces', () => {
    expect(placeholdersIn('{"to":"{{to}}","t":"{{ text }}","x":"{{nope}}"}')).toEqual(['to', 'text', 'nope'])
  })

  it('escapes values for JSON, so a message cannot break out of its field', () => {
    const body = renderBody('{"to":"{{to}}","text":"{{text}}"}', { to: '+49151', text: 'Code "1234"\nline\\two', from: '' }, 'application/json')
    expect(JSON.parse(body)).toEqual({ to: '+49151', text: 'Code "1234"\nline\\two' })
  })

  it('percent-encodes values for a form', () => {
    const body = renderBody('To={{to}}&Body={{text}}&From={{from}}', { to: '+49151', text: 'a&b=c d', from: 'pforte' }, 'application/x-www-form-urlencoded')
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({ To: '+49151', Body: 'a&b=c d', From: 'pforte' })
  })
})

describe('HTTP SMS sender', () => {
  let server: Server
  let url: string
  const received: { method?: string; headers: IncomingMessage['headers']; body: string }[] = []
  let answers: number[] = []

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        received.push({ method: request.method, headers: request.headers, body })
        response.statusCode = answers.shift() ?? 201
        if (response.statusCode === 302) response.setHeader('location', 'http://127.0.0.1:1/elsewhere')
        response.end('{"sid":"SM123","to":"+4915112345678","body":"secret code 424242"}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/messages`
  })

  afterAll(() => {
    server.close()
  })

  const settings = (extra: Partial<HttpSmsSettings> = {}): HttpSmsSettings => ({
    url,
    method: 'POST',
    headers: { authorization: 'Basic c2VjcmV0' },
    contentType: 'application/x-www-form-urlencoded',
    body: 'To={{to}}&From={{from}}&Body={{text}}',
    from: 'pforte',
    ...extra,
  })
  const noWait = { sleep: async () => {} }

  it('sends the message the way the provider wants it, with the configured credentials', async () => {
    received.length = 0
    await createHttpSmsSender(settings(), noWait).send({ to: '+4915112345678', text: '424242 is your code & more' })

    expect(received).toHaveLength(1)
    expect(received[0]!.method).toBe('POST')
    expect(received[0]!.headers.authorization).toBe('Basic c2VjcmV0')
    expect(received[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(new URLSearchParams(received[0]!.body))).toEqual({ To: '+4915112345678', From: 'pforte', Body: '424242 is your code & more' })
  })

  it('sends JSON when configured so', async () => {
    received.length = 0
    await createHttpSmsSender(
      settings({ contentType: 'application/json', body: '{"to":"{{to}}","text":"{{text}}","from":"{{from}}"}', headers: { 'x-api-key': 'k' } }),
      noWait,
    ).send({ to: '+49151', text: 'Code "7"' })
    expect(received[0]!.headers['content-type']).toBe('application/json')
    expect(received[0]!.headers['x-api-key']).toBe('k')
    expect(JSON.parse(received[0]!.body)).toEqual({ to: '+49151', text: 'Code "7"', from: 'pforte' })
  })

  it('tries again after a server error and succeeds', async () => {
    received.length = 0
    answers = [503]
    await createHttpSmsSender(settings(), noWait).send({ to: '+49151', text: 'x' })
    expect(received).toHaveLength(2)
  })

  it('gives up after the retries and does not reveal what the provider answered', async () => {
    received.length = 0
    answers = [500, 500]
    const error = await createHttpSmsSender(settings(), noWait).send({ to: '+4915112345678', text: 'x' }).catch((caught) => caught)
    expect(error).toBeInstanceOf(NotifierUnavailableError)
    expect(received).toHaveLength(2)
    expect(error.message).not.toContain('424242')
    expect(error.message).not.toContain('4915112345678')
  })

  it('does not retry a refusal, and names the status without the answer', async () => {
    received.length = 0
    answers = [401]
    const error = await createHttpSmsSender(settings(), noWait).send({ to: '+49151', text: 'x' }).catch((caught) => caught)
    expect(error).toBeInstanceOf(NotifierUnavailableError)
    expect(error.message).toContain('HTTP 401')
    expect(error.message).not.toContain('SM123')
    expect(received).toHaveLength(1)
  })

  it('checks the body for providers that say 200 when they refuse', async () => {
    received.length = 0
    const sender = createHttpSmsSender(settings({ successPattern: /"success":\s*"100"/ }), noWait)
    // the fake server answers with its fixed body, which has no "success" field: refused, and not retried
    const error = await sender.send({ to: '+49151', text: 'x' }).catch((caught) => caught)
    expect(error).toBeInstanceOf(NotifierUnavailableError)
    expect(error.message).toContain('did not accept')
    expect(received).toHaveLength(1)
  })

  it('accepts the answer when the body matches', async () => {
    received.length = 0
    await createHttpSmsSender(settings({ successPattern: /"sid":"SM123"/ }), noWait).send({ to: '+49151', text: 'x' })
    expect(received).toHaveLength(1)
  })

  it('reports an unreachable provider', async () => {
    const error = await createHttpSmsSender(settings({ url: 'http://127.0.0.1:1/x' }), { ...noWait, timeoutMs: 500 })
      .send({ to: '+49151', text: 'x' })
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(NotifierUnavailableError)
  })

  it('does not follow redirects, which could send the credentials elsewhere', async () => {
    received.length = 0
    answers = [302]
    const error = await createHttpSmsSender(settings(), noWait).send({ to: '+49151', text: 'x' }).catch((caught) => caught)
    expect(error).toBeInstanceOf(NotifierUnavailableError)
    expect(received).toHaveLength(1)
  })
})
