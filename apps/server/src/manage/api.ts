import type { FastifyInstance, FastifyRequest } from 'fastify'

export interface ApiCall {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  /** Below `/admin`, e.g. `/users?search=ada`. */
  url: string
  body?: unknown
}

/**
 * Calls the admin API for the person who is signed in: the very same routes a machine uses, with the person's
 * own token, in this process and without a network in between. Their address and browser are passed along, so the
 * audit log records them. Nothing the UI does bypasses the API.
 */
export const createApiCaller = (app: FastifyInstance) => (request: FastifyRequest, token: string, { method, url, body }: ApiCall) =>
  app.inject({
    method,
    url: `/admin${url}`,
    headers: {
      authorization: `Bearer ${token}`,
      'user-agent': request.headers['user-agent'] ?? '',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
    remoteAddress: request.ip,
  })

export type ApiCaller = ReturnType<typeof createApiCaller>
