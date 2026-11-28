import type { Database } from '@progwise/pforte-db'
import { findPicture } from '@progwise/pforte-db/admin'
import type { FastifyInstance } from 'fastify'
import { PICTURES_PATH } from './address.js'

/** How long a browser or a proxy may keep a picture: a day. Not longer, so that a picture that was removed is gone from them soon. */
export const PICTURE_MAX_AGE_SECONDS = 24 * 60 * 60

/**
 * Serves the pictures of people, at the address applications get as the claim `picture`.
 *
 * Without a sign-in: an application fetches the picture from its own server, or puts the address into a page of
 * its own, and neither has a session at pforte. What protects a picture is its address, which is random, names
 * nobody and changes with every new picture; there is no list of them. Whoever has the address has the picture.
 *
 * Only what pforte made itself is served here (`preparePicture`), as a JPEG and as nothing else: no file a person
 * uploaded reaches a browser.
 */
export const pictureRoutes =
  ({ db }: { db: Database }) =>
  async (app: FastifyInstance) => {
    app.get<{ Params: { key: string } }>(`${PICTURES_PATH}/:key`, async (request, reply) => {
      const { key } = request.params
      const picture = /^[\w-]{22}$/.test(key) ? await findPicture(db, key) : undefined
      if (!picture) return reply.code(404).header('Cache-Control', 'no-store').type('text/plain').send('Not found')

      // The address is the version: what it answers never changes, it only ends.
      const etag = `"${key}"`
      reply
        .header('Cache-Control', `public, max-age=${PICTURE_MAX_AGE_SECONDS}`)
        .header('ETag', etag)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        // Applications show the picture in pages of their own.
        .header('Cross-Origin-Resource-Policy', 'cross-origin')
      if (request.headers['if-none-match'] === etag) return reply.code(304).send()
      return reply.type('image/jpeg').send(picture.image)
    })
  }
