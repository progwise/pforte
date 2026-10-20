import type { FastifyInstance } from 'fastify'

export interface SecurityHeaderOptions {
  /** Whether the service is reached over https, which is when HSTS means something. */
  https: boolean
}

/**
 * Headers every response carries, pages and API alike.
 *
 * - `nosniff`: a browser must not guess that data is a script or a page.
 * - `Referrer-Policy: no-referrer`: links and the activation token in an address are not passed on.
 * - `X-Frame-Options: DENY`: nothing of pforte can be put in a frame (our pages also say so in their policy).
 * - `Permissions-Policy`: nothing of pforte needs a camera, microphone, location, payment or USB.
 * - HSTS for https: for a year, browsers speak https to this host only. No `includeSubDomains` and no preload:
 *   those would bind other services on the domain too, which is the operator's decision, not pforte's.
 *
 * There is deliberately no `Cross-Origin-Opener-Policy`: with `same-origin` an application that opens the sign-in
 * in a popup loses the link to it, and popup sign-ins are part of OpenID Connect (`display=popup`).
 * There is no global Content-Security-Policy either: the provider's own logout page needs inline styles and
 * script. Our pages bring their own strict one.
 *
 * Set on the raw response, so that they are also present on answers the OpenID provider writes itself.
 */
export const securityHeaders = (https: boolean) => ({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), browsing-topics=()',
  ...(https ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
})

export const addSecurityHeaders = (app: FastifyInstance, { https }: SecurityHeaderOptions) => {
  const headers = Object.entries(securityHeaders(https))
  app.addHook('onRequest', async (_request, reply) => {
    for (const [name, value] of headers) reply.raw.setHeader(name, value)
  })
}
