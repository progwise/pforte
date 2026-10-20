import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * Whether a request to one of our forms may have come from somewhere else. Browsers say where a request
 * comes from: `Sec-Fetch-Site` (all current ones) and `Origin` (on every POST). A form of ours is only ever
 * submitted from our own page, so a POST that says anything else is somebody else's page pointing a form at us.
 * Requests that say nothing, such as those of tools like curl, are not browsers and cannot be tricked that way.
 */
export const isForeignPost = (request: FastifyRequest, issuer: string) => {
  const site = request.headers['sec-fetch-site']
  if (typeof site === 'string') return site !== 'same-origin'

  const origin = request.headers.origin
  if (typeof origin !== 'string') return false
  try {
    return new URL(origin).origin !== new URL(issuer).origin
  } catch {
    return true // "null" and anything else that is not an address
  }
}

/** A hook for a plugin that serves our forms: refuses POSTs from other sites before anything happens. */
export const refuseForeignPosts =
  (issuer: string, refuse: (request: FastifyRequest, reply: FastifyReply) => unknown) => async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method === 'POST' && isForeignPost(request, issuer)) {
      request.log.warn({ site: request.headers['sec-fetch-site'], origin: request.headers.origin }, 'refused a form post from another site')
      return refuse(request, reply)
    }
  }
