import type { IncomingMessage } from 'node:http'

/**
 * The provider builds absolute URLs and decides whether cookies are Secure from the request's
 * host and protocol. Those would otherwise follow whatever Host header a client or proxy sends,
 * so they are overwritten with the configured issuer: every URL derives from ISSUER.
 */
export const applyIssuerHeaders = (request: IncomingMessage, issuer: string) => {
  const url = new URL(issuer)
  request.headers.host = url.host
  request.headers['x-forwarded-proto'] = url.protocol.replace(':', '')
  delete request.headers['x-forwarded-host']
}
