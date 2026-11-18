import type { FastifyReply } from 'fastify'
import { waitValues } from '../i18n/duration.js'
import type { PageSet } from './pages.js'

/** What a page says when a limit says "not now": how long to wait. */
export const limitText = (view: PageSet, waitSeconds: number) => view.t('limit.text', waitValues(waitSeconds))

/** The answer when a limit says "not now": 429 with `Retry-After`, and a page that says how long to wait. */
export const tooManyRequests = (reply: FastifyReply, view: PageSet, waitSeconds: number) =>
  reply.code(429).header('Retry-After', waitSeconds).type('text/html').send(view.notice(view.t('limit.title'), limitText(view, waitSeconds)))
