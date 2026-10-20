import type { FastifyReply, FastifyRequest } from 'fastify'
import type { MessageKey } from '../i18n/index.js'
import { escapeHtml } from '../ui/pages.js'
import type { ManageContext, ManageSession } from './context.js'
import { link } from './html.js'

/** A text field of a form body, trimmed; empty when it is missing. */
export const text = (body: Record<string, unknown> | undefined, key: string) => (typeof body?.[key] === 'string' ? (body[key] as string).trim() : '')

/** All values of a field that can come several times, such as a group of tick boxes. */
export const many = (body: Record<string, unknown> | undefined, key: string) => {
  const value = body?.[key]
  return (Array.isArray(value) ? value : value === undefined ? [] : [value]).filter((item): item is string => typeof item === 'string')
}

/** The non-empty lines of a text area, trimmed. */
export const lines = (value: string) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

/** The API's answer as JSON, or nothing when it was not JSON. */
export const jsonOf = (response: { json: () => unknown }): unknown => {
  try {
    return response.json()
  } catch {
    return undefined
  }
}

/** Puts an error message above the content of a page that was rendered without one. */
export const withAlert = (html: string, message: string) =>
  html.replace('<main class="page" id="content">', `<main class="page" id="content">\n<p class="flash error" role="alert">${escapeHtml(message)}</p>`)

/** The pages every section needs: "not found", and "the API refused". */
export const createCommon = (ctx: ManageContext) => {
  const { page, viewFor, problemText } = ctx

  const notFound = (request: FastifyRequest, reply: FastifyReply, session: ManageSession, current: string, back: { href: string; label: MessageKey }) => {
    const { t } = viewFor(request, session)
    return reply
      .code(404)
      .type('text/html')
      .send(
        page(
          request,
          reply,
          session,
          current,
          t('manage.notFound.title'),
          `<h1>${escapeHtml(t('manage.notFound.title'))}</h1>\n<p>${escapeHtml(t('manage.notFound.text'))}</p>\n<p>${link(back.href, t(back.label), 'button')}</p>`,
        ),
      )
  }

  const failed = (request: FastifyRequest, reply: FastifyReply, session: ManageSession, current: string, response: { statusCode: number; json: () => unknown }) => {
    const { t } = viewFor(request, session)
    return reply
      .code(response.statusCode >= 400 && response.statusCode < 600 ? response.statusCode : 502)
      .type('text/html')
      .send(page(request, reply, session, current, t('manage.error.title'), `<h1>${escapeHtml(t('manage.error.title'))}</h1>\n<p>${escapeHtml(problemText(jsonOf(response)))}</p>`))
  }

  return { notFound, failed }
}
