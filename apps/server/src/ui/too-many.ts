import type { FastifyReply } from 'fastify'
import type { PageSet } from './pages.js'

/** The answer when a limit says "not now": 429 with `Retry-After`, and a page that says how long to wait. */
export const tooManyRequests = (reply: FastifyReply, view: PageSet, waitSeconds: number) =>
  reply
    .code(429)
    .header('Retry-After', waitSeconds)
    .type('text/html')
    .send(view.notice(view.t('limit.title'), view.t('limit.text', { minutes: Math.max(1, Math.ceil(waitSeconds / 60)) })))
