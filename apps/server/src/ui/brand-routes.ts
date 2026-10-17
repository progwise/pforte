import type { FastifyInstance } from 'fastify'
import type { Asset } from './theme.js'

/**
 * Serves the logo and the fonts of the branding folder. The paths contain a hash of the file, so the
 * answer for a path never changes and browsers may keep it for a year. Only files that were read at
 * startup are served: nothing is looked up on disk per request, so no path can reach anything else.
 */
export const brandRoutes = (assets: Asset[]) => async (app: FastifyInstance) => {
  const byPath = new Map(assets.map((asset) => [asset.path, asset]))

  app.get<{ Params: { '*': string } }>('/brand/*', async (request, reply) => {
    const asset = byPath.get(request.params['*'])
    if (!asset) return reply.code(404).type('text/plain').send('Not found')
    return reply
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('X-Content-Type-Options', 'nosniff')
      // An SVG logo is shown in an <img>, where it cannot run anything. This keeps it that way if somebody opens it directly.
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header('Cross-Origin-Resource-Policy', 'same-origin')
      .type(asset.type)
      .send(Buffer.from(asset.bytes))
  })
}
