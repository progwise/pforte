import type { FastifyReply } from 'fastify'
import { escapeHtml } from '../ui/pages.js'
import { PICTURES_PATH } from './address.js'

/**
 * Makes this answer a page that may show a person's picture: the policy of every page, with pictures from
 * pforte's own address. Pages without one keep the policy they have, which names pictures only where there is a
 * logo.
 */
export const allowPictures = (reply: FastifyReply, policy: string) => reply.header('Content-Security-Policy', policy.includes('img-src') ? policy : `${policy}; img-src 'self'`)

/** A person's picture on a page of pforte. `alt` says whose it is. */
export const pictureElement = (key: string, alt: string) => `<img class="avatar" src="${PICTURES_PATH}/${escapeHtml(key)}" alt="${escapeHtml(alt)}" width="96" height="96">`
