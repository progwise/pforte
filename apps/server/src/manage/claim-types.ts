import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { escapeHtml } from '../ui/pages.js'
import { createCommon, jsonOf, text, withAlert } from './common.js'
import { MANAGE_PATH } from './constants.js'
import type { ManageContext, ManageSession } from './context.js'
import { checkbox, field, link } from './html.js'

const BASE = `${MANAGE_PATH}/claim-types`
const SECTION = 'claim-types'

interface ApiClaimType {
  key: string
  description: string
  valuePattern: string | null
  multiValued: boolean
  clients: string[]
}

interface ClaimTypeForm {
  key: string
  description: string
  valuePattern: string
  multiValued: boolean
}

const formOf = (type: ApiClaimType): ClaimTypeForm => ({ key: type.key, description: type.description, valuePattern: type.valuePattern ?? '', multiValued: type.multiValued })
const formFrom = (body: Record<string, unknown> | undefined): ClaimTypeForm => ({
  key: text(body, 'key'),
  description: text(body, 'description'),
  valuePattern: text(body, 'valuePattern'),
  multiValued: body?.multiValued === 'on',
})
const hrefOf = (key: string) => `${BASE}/${encodeURIComponent(key)}`

/** The claim types: they have to exist before a person can hold a claim, and each client gets the ones assigned to it. */
export const registerClaimTypes = (app: FastifyInstance, ctx: ManageContext) => {
  const { requireSession, api, page, viewFor, redirectWith, problemText, fieldErrors, sessionEnded } = ctx
  const { notFound, failed } = createCommon(ctx)
  const back = { href: BASE, label: 'manage.claimTypes.back' } as const

  const fields = (t: ReturnType<typeof viewFor>['t'], values: ClaimTypeForm, errors: Record<string, string>, creating: boolean) => `${
    creating ? field({ id: 'key', label: t('manage.claimTypes.key'), value: values.key, hint: t('manage.claimTypes.keyHint'), error: errors.key, required: true, maxLength: 64 }) : ''
  }
${field({ id: 'description', label: t('manage.claimTypes.description'), value: values.description, hint: t('manage.claimTypes.descriptionHint'), error: errors.description, maxLength: 500 })}
${field({ id: 'valuePattern', label: t('manage.claimTypes.pattern'), value: values.valuePattern, hint: t('manage.claimTypes.patternHint'), error: errors.valuePattern, maxLength: 200 })}
${checkbox({ id: 'multiValued', label: t('manage.claimTypes.multiValued'), checked: values.multiValued })}`

  // --- The list, with the form for a new one below it

  const listPage = async (
    request: FastifyRequest,
    reply: FastifyReply,
    session: ManageSession,
    extra: { form?: ClaimTypeForm; errors?: Record<string, string>; error?: string; status?: number } = {},
  ) => {
    const { t } = viewFor(request, session)
    const response = await api(request, session, { method: 'GET', url: '/claim-types' })
    if (response.statusCode === 401) return sessionEnded(reply)
    if (response.statusCode !== 200) return failed(request, reply, session, SECTION, response)
    const items = response.json().items as ApiClaimType[]

    const rows = items
      .map(
        (type) => `<tr>
<td>${link(hrefOf(type.key), type.key)}</td>
<td>${escapeHtml(type.description)}</td>
<td>${type.valuePattern ? `<code>${escapeHtml(type.valuePattern)}</code>` : `<span class="muted">${escapeHtml(t('manage.claimTypes.anyFormat'))}</span>`}</td>
<td>${escapeHtml(t(type.multiValued ? 'manage.claimTypes.several' : 'manage.claimTypes.one'))}</td>
<td>${type.clients.length ? type.clients.map((client) => link(`${MANAGE_PATH}/clients/${encodeURIComponent(client)}`, client)).join(', ') : `<span class="muted">${escapeHtml(t('manage.none'))}</span>`}</td>
</tr>`,
      )
      .join('\n')

    const content = `<h1>${escapeHtml(t('manage.claimTypes.title'))}</h1>
<p class="muted">${escapeHtml(t('manage.claimTypes.intro'))}</p>
${
  items.length
    ? `<div class="scroll"><table class="list">
<thead><tr><th>${escapeHtml(t('manage.claimTypes.key'))}</th><th>${escapeHtml(t('manage.claimTypes.description'))}</th><th>${escapeHtml(t('manage.claimTypes.format'))}</th><th>${escapeHtml(t('manage.claimTypes.values'))}</th><th>${escapeHtml(t('manage.claimTypes.clients'))}</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>`
    : `<p class="muted">${escapeHtml(t('manage.claimTypes.none'))}</p>`
}
<h2>${escapeHtml(t('manage.claimTypes.new'))}</h2>
<div class="panel"><form class="fields" method="post" action="${BASE}">
${fields(t, extra.form ?? { key: '', description: '', valuePattern: '', multiValued: false }, extra.errors ?? {}, true)}
<div class="submit"><button type="submit">${escapeHtml(t('manage.claimTypes.create'))}</button></div>
</form></div>`
    const html = page(request, reply, session, SECTION, t('manage.claimTypes.title'), content)
    return reply.code(extra.status ?? 200).type('text/html').send(extra.error ? withAlert(html, extra.error) : html)
  }

  app.get(BASE, async (request, reply) => {
    const session = requireSession(request, reply)
    return session ? listPage(request, reply, session) : reply
  })

  app.post<{ Body: Record<string, unknown> }>(BASE, async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const { t } = viewFor(request, session)
    const values = formFrom(request.body)

    const response = await api(request, session, {
      method: 'POST',
      url: '/claim-types',
      body: { key: values.key, description: values.description, valuePattern: values.valuePattern || null, multiValued: values.multiValued },
    })
    if (response.statusCode === 401) return sessionEnded(reply)
    if (response.statusCode === 201) return redirectWith(reply, BASE, { kind: 'ok', key: 'manage.claimTypes.created', values: { key: values.key } })

    const body = jsonOf(response)
    return listPage(request, reply, session, {
      form: values,
      errors: fieldErrors(body),
      error: response.statusCode === 400 ? t('manage.form.invalid') : t('manage.form.failed', { reason: problemText(body) }),
      status: response.statusCode === 400 ? 422 : response.statusCode,
    })
  })

  // --- One claim type

  const load = async (request: FastifyRequest, reply: FastifyReply, session: ManageSession, key: string) => {
    const response = await api(request, session, { method: 'GET', url: '/claim-types' })
    if (response.statusCode === 401) return { stop: sessionEnded(reply) }
    if (response.statusCode !== 200) return { stop: failed(request, reply, session, SECTION, response) }
    const type = (response.json().items as ApiClaimType[]).find((item) => item.key === key)
    return type ? { type } : { stop: notFound(request, reply, session, SECTION, back) }
  }

  const detail = (request: FastifyRequest, reply: FastifyReply, session: ManageSession, type: ApiClaimType, extra: { form?: ClaimTypeForm; errors?: Record<string, string>; error?: string; status?: number } = {}) => {
    const { t } = viewFor(request, session)
    const content = `<p>${link(BASE, `← ${t('manage.claimTypes.back')}`)}</p>
<h1>${escapeHtml(type.key)}</h1>
<div class="panel"><form class="fields" method="post" action="${hrefOf(type.key)}">
${fields(t, extra.form ?? formOf(type), extra.errors ?? {}, false)}
<div class="submit"><button type="submit">${escapeHtml(t('manage.claimTypes.save'))}</button></div>
</form></div>
<h2>${escapeHtml(t('manage.claimTypes.usedBy'))}</h2>
<div class="panel">${
      type.clients.length
        ? `<p>${type.clients.map((client) => link(`${MANAGE_PATH}/clients/${encodeURIComponent(client)}`, client)).join(', ')}</p>`
        : `<p class="muted">${escapeHtml(t('manage.claimTypes.usedByNone'))}</p>`
    }</div>
<div class="actions">${link(`${hrefOf(type.key)}/delete`, t('manage.claimTypes.delete'), 'button secondary')}</div>`
    const html = page(request, reply, session, SECTION, type.key, content)
    return reply.code(extra.status ?? 200).type('text/html').send(extra.error ? withAlert(html, extra.error) : html)
  }

  app.get<{ Params: { key: string } }>(`${BASE}/:key`, async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const { type, stop } = await load(request, reply, session, request.params.key)
    return type ? detail(request, reply, session, type) : stop
  })

  app.post<{ Params: { key: string }; Body: Record<string, unknown> }>(`${BASE}/:key`, async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const { type, stop } = await load(request, reply, session, request.params.key)
    if (!type) return stop
    const { t } = viewFor(request, session)
    const values = { ...formFrom(request.body), key: type.key }

    const response = await api(request, session, {
      method: 'PATCH',
      url: `/claim-types/${encodeURIComponent(type.key)}`,
      body: { description: values.description, valuePattern: values.valuePattern || null, multiValued: values.multiValued },
    })
    if (response.statusCode === 401) return sessionEnded(reply)
    if (response.statusCode === 200) {
      const saved = response.json() as ApiClaimType
      const same = saved.description === type.description && saved.valuePattern === type.valuePattern && saved.multiValued === type.multiValued
      return redirectWith(reply, hrefOf(type.key), same ? { kind: 'ok', key: 'manage.claimTypes.unchanged' } : { kind: 'ok', key: 'manage.claimTypes.saved', values: { key: type.key } })
    }
    if (response.statusCode === 404) return notFound(request, reply, session, SECTION, back)

    const body = jsonOf(response)
    return detail(request, reply, session, type, {
      form: values,
      errors: fieldErrors(body),
      error: response.statusCode === 400 ? t('manage.form.invalid') : t('manage.form.failed', { reason: problemText(body) }),
      status: response.statusCode === 400 ? 422 : response.statusCode,
    })
  })

  // --- Deleting asks first, and whether the values people hold go too

  const confirmation = (request: FastifyRequest, reply: FastifyReply, session: ManageSession, type: ApiClaimType, problem?: { status: number; text: string; force: boolean }) => {
    const { t } = viewFor(request, session)
    const title = t('manage.claimTypes.delete.title', { key: type.key })
    const body = `<p>${escapeHtml(t('manage.claimTypes.delete.text'))}</p>
<form class="fields" method="post" action="${hrefOf(type.key)}/delete">
${checkbox({ id: 'force', label: t('manage.claimTypes.delete.force'), checked: problem?.force })}
<div class="submit"><button type="submit" class="danger">${escapeHtml(t('manage.claimTypes.delete'))}</button> ${link(hrefOf(type.key), t('manage.cancel'), 'button secondary')}</div>
</form>`
    const html = page(request, reply, session, SECTION, title, `<h1>${escapeHtml(title)}</h1>\n<div class="panel">${body}</div>`)
    return reply.code(problem?.status ?? 200).type('text/html').send(problem ? withAlert(html, problem.text) : html)
  }

  app.get<{ Params: { key: string } }>(`${BASE}/:key/delete`, async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const { type, stop } = await load(request, reply, session, request.params.key)
    return type ? confirmation(request, reply, session, type) : stop
  })

  app.post<{ Params: { key: string }; Body: Record<string, unknown> }>(`${BASE}/:key/delete`, async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const { type, stop } = await load(request, reply, session, request.params.key)
    if (!type) return stop
    const force = request.body?.force === 'on'

    const response = await api(request, session, { method: 'DELETE', url: `/claim-types/${encodeURIComponent(type.key)}?force=${force}` })
    if (response.statusCode === 401) return sessionEnded(reply)
    if (response.statusCode >= 400) {
      return confirmation(request, reply, session, type, { status: response.statusCode < 600 ? response.statusCode : 502, text: problemText(jsonOf(response)), force })
    }
    return redirectWith(reply, BASE, { kind: 'ok', key: 'manage.claimTypes.deleted', values: { key: type.key } })
  })
}
