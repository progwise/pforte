import type { FastifyRequest } from 'fastify'

/**
 * Query parameters whose values are secret or personal: the one-time token of an activation link, an
 * e-mail address, a hint that holds one, a signed token, a code. They are in the address of a request, so
 * they would end up in the access log of pforte and of anything that collects its logs.
 */
const SENSITIVE_PARAMETERS = ['token', 'email', 'login_hint', 'id_token_hint', 'code', 'client_secret', 'password', 'access_token', 'refresh_token']

/** The address of a request with the values of sensitive parameters replaced, for the log. */
export const redactUrl = (url: string) => {
  const queryStart = url.indexOf('?')
  if (queryStart === -1) return url
  const parameters = new URLSearchParams(url.slice(queryStart + 1))
  for (const name of SENSITIVE_PARAMETERS) {
    if (parameters.has(name)) parameters.set(name, 'REDACTED')
  }
  return `${url.slice(0, queryStart)}?${parameters}`
}

/** How a request appears in the log: what Fastify logs by default, with the address redacted. */
export const logSerializers = {
  req: (request: FastifyRequest) => ({
    method: request.method,
    url: redactUrl(request.url),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  }),
}
