import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { MessageKey } from '../i18n/index.js'
import { escapeHtml } from '../ui/pages.js'
import { createCommon, jsonOf, lines, many, text, withAlert } from './common.js'
import { MANAGE_PATH } from './constants.js'
import type { ManageContext, ManageSession } from './context.js'
import { badge, checkbox, checks, field, link, select, textarea } from './html.js'

const BASE = `${MANAGE_PATH}/clients`
const SECTION = 'clients'
const APPLICATION_SCOPES = ['openid', 'offline_access', 'profile', 'email', 'phone'] as const
const MACHINE_SCOPES = ['admin', 'directory'] as const

interface ApiClient {
  system: boolean
  clientId: string
  name: string
  type: 'public' | 'confidential'
  clientUri: string | null
  redirectUris: string[]
  postLogoutRedirectUris: string[]
  backchannelLogoutUri: string | null
  backchannelLogoutSessionRequired: boolean
  allowedGrants: string[]
  scopes: string[]
  pkceRequired: boolean
  claimTypes: string[]
  createdAt: string
  updatedAt: string
}

type Kind = 'application' | 'machine' | 'system'
const kindOf = (client: Pick<ApiClient, 'system' | 'allowedGrants'>): Kind => (client.system ? 'system' : client.allowedGrants.includes('client_credentials') ? 'machine' : 'application')
const hrefOf = (clientId: string) => `${BASE}/${encodeURIComponent(clientId)}`

/** What a person typed into the form of a client, kept so a refused form comes back as it was filled in. */
interface ClientForm {
  clientId: string
  name: string
  type: 'public' | 'confidential'
  clientUri: string
  redirectUris: string
  postLogoutRedirectUris: string
  backchannelLogoutUri: string
  sessionRequired: boolean
  refresh: boolean
  scopes: string[]
  pkce: boolean
}

const formOf = (client: ApiClient): ClientForm => ({
  clientId: client.clientId,
  name: client.name,
  type: client.type,
  clientUri: client.clientUri ?? '',
  redirectUris: client.redirectUris.join('\n'),
  postLogoutRedirectUris: client.postLogoutRedirectUris.join('\n'),
  backchannelLogoutUri: client.backchannelLogoutUri ?? '',
  sessionRequired: client.backchannelLogoutSessionRequired,
  refresh: client.allowedGrants.includes('refresh_token'),
  scopes: client.scopes,
  pkce: client.pkceRequired,
})

const emptyForm = (kind: 'application' | 'machine'): ClientForm => ({
  clientId: '',
  name: '',
  type: kind === 'machine' ? 'confidential' : 'public',
  clientUri: '',
  redirectUris: '',
  postLogoutRedirectUris: '',
  backchannelLogoutUri: '',
  sessionRequired: false,
  refresh: true,
  scopes: kind === 'machine' ? [] : ['openid', 'profile', 'email'],
  pkce: true,
})

const formFrom = (body: Record<string, unknown> | undefined): ClientForm => ({
  clientId: text(body, 'clientId'),
  name: text(body, 'name'),
  type: text(body, 'type') === 'confidential' ? 'confidential' : 'public',
  clientUri: text(body, 'clientUri'),
  redirectUris: typeof body?.redirectUris === 'string' ? body.redirectUris : '',
  postLogoutRedirectUris: typeof body?.postLogoutRedirectUris === 'string' ? body.postLogoutRedirectUris : '',
  backchannelLogoutUri: text(body, 'backchannelLogoutUri'),
  sessionRequired: body?.sessionRequired === 'on',
  refresh: body?.refresh === 'on',
  scopes: many(body, 'scopes'),
  pkce: body?.pkce === 'on',
})

/** What the API takes for a form: the same for creating and changing, except what cannot change. */
const payloadOf = (kind: 'application' | 'machine', form: ClientForm) =>
  kind === 'machine'
    ? { name: form.name, scopes: form.scopes.filter((scope) => (MACHINE_SCOPES as readonly string[]).includes(scope)) }
    : {
        name: form.name,
        clientUri: form.clientUri || null,
        redirectUris: lines(form.redirectUris),
        postLogoutRedirectUris: lines(form.postLogoutRedirectUris),
        backchannelLogoutUri: form.backchannelLogoutUri || null,
        backchannelLogoutSessionRequired: form.sessionRequired,
        allowedGrants: ['authorization_code', ...(form.refresh ? ['refresh_token'] : [])],
        scopes: ['openid', ...form.scopes.filter((scope) => scope !== 'openid' && (APPLICATION_SCOPES as readonly string[]).includes(scope))],
        pkceRequired: form.type === 'public' ? true : form.pkce,
      }

/** The clients of pforte: the applications that sign people in and the machines that call the API. */
export const registerClients = (app: FastifyInstance, ctx: ManageContext) => {
  const { requireSession, api, page, viewFor, redirectWith, problemText, fieldErrors, formatTime, sessionEnded } = ctx
  const { notFound, failed } = createCommon(ctx)
  const back = { href: BASE, label: 'manage.clients.back' } as const
  const missing = (request: FastifyRequest, reply: FastifyReply, session: ManageSession) => notFound(request, reply, session, SECTION, back)
  const kindBadge = (t: (key: MessageKey) => string, kind: Kind) => badge(kind === 'system' ? 'locked' : kind, t(`manage.client.kind.${kind}`))

  // --- The list

  app.get(BASE, async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const { t } = viewFor(request, session)
    const response = await api(request, session, { method: 'GET', url: '/clients' })
    if (response.statusCode === 401) return sessionEnded(reply)
    if (response.statusCode !== 200) return failed(request, reply, session, SECTION, response)
    const items = response.json().items as ApiClient[]

    const rows = items
      .map(
        (client) => `<tr>
<td>${link(hrefOf(client.clientId), client.name)}</td>
<td><code>${escapeHtml(client.clientId)}</code></td>
<td>${kindBadge(t, kindOf(client))}</td>
<td>${escapeHtml(t(`manage.client.type.${client.type}`))}</td>
</tr>`,
      )
      .join('\n')

    const content = `<h1>${escapeHtml(t('manage.clients.title'))}</h1>
<p class="muted">${escapeHtml(t('manage.clients.intro'))}</p>
<div class="actions">${link(`${BASE}/new`, t('manage.clients.new'), 'button')}</div>
${
  items.length
    ? `<div class="scroll"><table class="list">
<thead><tr><th>${escapeHtml(t('manage.clients.name'))}</th><th>${escapeHtml(t('manage.clients.id'))}</th><th>${escapeHtml(t('manage.clients.kind'))}</th><th>${escapeHtml(t('manage.clients.type'))}</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>`
    : `<p class="muted">${escapeHtml(t('manage.clients.none'))}</p>`
}`
    return reply.type('text/html').send(page(request, reply, session, SECTION, t('manage.clients.title'), content))
  })

  // --- The form: the same fields to create and to change

  const formFields = (t: ReturnType<typeof viewFor>['t'], kind: 'application' | 'machine', values: ClientForm, errors: Record<string, string>, { creating }: { creating: boolean }) => {
    const common = `${creating ? field({ id: 'clientId', label: t('manage.clientForm.clientId'), value: values.clientId, hint: t('manage.clientForm.clientIdHint'), error: errors.clientId, required: true, maxLength: 63 }) : ''}
${field({ id: 'name', label: t('manage.clientForm.name'), value: values.name, error: errors.name, required: true, maxLength: 200 })}`

    if (kind === 'machine') {
      return `${common}
${checks({ legend: t('manage.clientForm.rights'), name: 'scopes', hint: t('manage.clientForm.rightsHint'), error: errors.scopes, choices: MACHINE_SCOPES.map((scope) => ({ value: scope, label: scope, checked: values.scopes.includes(scope) })) })}`
    }

    return `${common}
${creating ? select({ id: 'type', label: t('manage.clientForm.type'), value: values.type, choices: [{ value: 'public', label: t('manage.clientForm.typePublic') }, { value: 'confidential', label: t('manage.clientForm.typeConfidential') }] }) : ''}
${field({ id: 'clientUri', label: t('manage.clientForm.clientUri'), value: values.clientUri, hint: t('manage.clientForm.clientUriHint'), error: errors.clientUri })}
${textarea({ id: 'redirectUris', label: t('manage.clientForm.redirectUris'), value: values.redirectUris, hint: t('manage.clientForm.redirectUrisHint'), error: errors.redirectUris, rows: 3 })}
${textarea({ id: 'postLogoutRedirectUris', label: t('manage.clientForm.postLogoutRedirectUris'), value: values.postLogoutRedirectUris, hint: t('manage.clientForm.postLogoutRedirectUrisHint'), error: errors.postLogoutRedirectUris, rows: 2 })}
${field({ id: 'backchannelLogoutUri', label: t('manage.clientForm.backchannelLogoutUri'), value: values.backchannelLogoutUri, hint: t('manage.clientForm.backchannelLogoutUriHint'), error: errors.backchannelLogoutUri })}
${checks({
  legend: t('manage.clientForm.scopes'),
  name: 'scopes',
  hint: t('manage.clientForm.scopesHint'),
  error: errors.scopes,
  choices: APPLICATION_SCOPES.map((scope) => ({ value: scope, label: scope, checked: scope === 'openid' || values.scopes.includes(scope), disabled: scope === 'openid' })),
})}
${checkbox({ id: 'refresh', label: t('manage.clientForm.refresh'), checked: values.refresh })}
${checkbox({ id: 'sessionRequired', label: t('manage.clientForm.sessionRequired'), checked: values.sessionRequired })}
${values.type === 'confidential' || creating ? `${checkbox({ id: 'pkce', label: t('manage.clientForm.pkce'), checked: values.pkce })}\n<small class="muted">${escapeHtml(t('manage.clientForm.pkceHint'))}</small>` : ''}`
  }

  // --- New client: first the kind, then its form

  const newForm = (request: FastifyRequest, session: ManageSession, kind: 'application' | 'machine', values: ClientForm, errors: Record<string, string> = {}) => {
    const { t } = viewFor(request, session)
    return `<h1>${escapeHtml(t(`manage.clientNew.${kind}`))}</h1>
<p>${link(`${BASE}/new`, `← ${t('manage.clientNew.title')}`)} · ${link(BASE, t('manage.clients.back'))}</p>
<div class="panel"><form class="fields stack" method="post" action="${BASE}?kind=${kind}">
${formFields(t, kind, values, errors, { creating: true })}
<div class="submit"><button type="submit">${escapeHtml(t('manage.clientForm.create'))}</button></div>
</form></div>`
  }

  app.get<{ Querystring: { kind?: string } }>(`${BASE}/new`, async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const { t } = viewFor(request, session)
    const kind = request.query.kind
    if (kind === 'application' || kind === 'machine') {
      return reply.type('text/html').send(page(request, reply, session, SECTION, t(`manage.clientNew.${kind}`), newForm(request, session, kind, emptyForm(kind))))
    }
    const card = (which: 'application' | 'machine') => `<div class="panel"><h2>${escapeHtml(t(`manage.clientNew.${which}.title`))}</h2>
<p>${escapeHtml(t(`manage.clientNew.${which}.text`))}</p>
<p>${link(`${BASE}/new?kind=${which}`, t(`manage.clientNew.${which}`), 'button')}</p></div>`
    const content = `<h1>${escapeHtml(t('manage.clientNew.title'))}</h1>
<p>${link(BASE, `← ${t('manage.clients.back')}`)}</p>
<p>${escapeHtml(t('manage.clientNew.choose'))}</p>
<div class="cards">${card('application')}${card('machine')}</div>`
    return reply.type('text/html').send(page(request, reply, session, SECTION, t('manage.clientNew.title'), content))
  })

  /** The secret of a client, shown once: not stored, not cached, not in a redirect. */
  const secretPage = (request: FastifyRequest, reply: FastifyReply, session: ManageSession, client: Pick<ApiClient, 'clientId' | 'name'>, secret: string) => {
    const { t } = viewFor(request, session)
    const content = `<h1>${escapeHtml(t('manage.secret.title', { name: client.name }))}</h1>
<div class="panel">
<p>${escapeHtml(t('manage.secret.text'))}</p>
<p><strong>${escapeHtml(t('manage.secret.label'))}</strong></p>
<code class="secret">${escapeHtml(secret)}</code>
<p>${link(hrefOf(client.clientId), t('manage.secret.continue'), 'button')}</p>
</div>`
    return reply.header('Cache-Control', 'no-store').type('text/html').send(page(request, reply, session, SECTION, t('manage.secret.title', { name: client.name }), content))
  }

  app.post<{ Querystring: { kind?: string }; Body: Record<string, unknown> }>(BASE, async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const kind = request.query.kind === 'machine' ? 'machine' : 'application'
    const { t } = viewFor(request, session)
    const values = formFrom(request.body)
    if (kind === 'machine') values.type = 'confidential'

    const response = await api(request, session, {
      method: 'POST',
      url: '/clients',
      body: {
        clientId: values.clientId,
        type: values.type,
        ...payloadOf(kind, values),
        ...(kind === 'machine' ? { allowedGrants: ['client_credentials'] } : {}),
      },
    })
    if (response.statusCode === 401) return sessionEnded(reply)
    if (response.statusCode === 201) {
      const { client, clientSecret } = response.json() as { client: ApiClient; clientSecret: string | null }
      if (clientSecret) return secretPage(request, reply, session, client, clientSecret)
      return redirectWith(reply, hrefOf(client.clientId), { kind: 'ok', key: 'manage.client.created', values: { name: client.name } })
    }

    const body = jsonOf(response)
    const message = response.statusCode === 400 ? t('manage.clientForm.invalid') : t('manage.clientForm.failed', { reason: problemText(body) })
    const html = page(request, reply, session, SECTION, t(`manage.clientNew.${kind}`), newForm(request, session, kind, values, fieldErrors(body)))
    return reply.code(response.statusCode === 400 ? 422 : response.statusCode).type('text/html').send(withAlert(html, message))
  })

  // --- One client

  const load = async (request: FastifyRequest, reply: FastifyReply, session: ManageSession, clientId: string) => {
    const response = await api(request, session, { method: 'GET', url: `/clients/${encodeURIComponent(clientId)}` })
    if (response.statusCode === 401) return { stop: sessionEnded(reply) }
    if (response.statusCode === 404) return { stop: missing(request, reply, session) }
    if (response.statusCode !== 200) return { stop: failed(request, reply, session, SECTION, response) }
    return { client: response.json() as ApiClient }
  }

  const detail = async (
    request: FastifyRequest,
    reply: FastifyReply,
    session: ManageSession,
    client: ApiClient,
    extra: { form?: ClientForm; errors?: Record<string, string>; error?: string; status?: number; claims?: string[] } = {},
  ) => {
    const { t, language } = viewFor(request, session)
    const kind = kindOf(client)
    const types = await api(request, session, { method: 'GET', url: '/claim-types' })
    if (types.statusCode === 401) return sessionEnded(reply)
    const claimTypes = types.statusCode === 200 ? (types.json().items as { key: string; description: string }[]) : []

    const facts = `<dl class="facts">
<dt>${escapeHtml(t('manage.client.fact.kind'))}</dt><dd>${kindBadge(t, kind)}</dd>
<dt>${escapeHtml(t('manage.clients.id'))}</dt><dd><code>${escapeHtml(client.clientId)}</code></dd>
<dt>${escapeHtml(t('manage.client.fact.type'))}</dt><dd>${escapeHtml(t(`manage.client.type.${client.type}`))}</dd>
<dt>${escapeHtml(t('manage.client.fact.created'))}</dt><dd>${escapeHtml(formatTime(client.createdAt, language))}</dd>
${
  kind === 'system'
    ? `<dt>${escapeHtml(t('manage.client.fact.redirects'))}</dt><dd>${client.redirectUris.map((uri) => `<code>${escapeHtml(uri)}</code>`).join('<br>')}</dd>
<dt>${escapeHtml(t('manage.client.fact.scopes'))}</dt><dd>${escapeHtml(client.scopes.join(' '))}</dd>`
    : ''
}
</dl>`

    const editable = kind !== 'system'
    const settings = editable
      ? `<h2>${escapeHtml(t('manage.client.settings'))}</h2>
<div class="panel"><form class="fields stack" method="post" action="${hrefOf(client.clientId)}">
${formFields(t, kind as 'application' | 'machine', extra.form ?? formOf(client), extra.errors ?? {}, { creating: false })}
<div class="submit"><button type="submit">${escapeHtml(t('manage.clientForm.save'))}</button></div>
</form></div>`
      : `<p class="flash">${escapeHtml(t('manage.client.system'))}</p>`

    const held = new Set(extra.claims ?? client.claimTypes)
    const claims =
      kind === 'application'
        ? `<h2>${escapeHtml(t('manage.client.claims.title'))}</h2>
<div class="panel">
<p class="muted">${escapeHtml(t('manage.client.claims.help'))}</p>
${
  claimTypes.length
    ? `<form method="post" action="${hrefOf(client.clientId)}/claim-types">
${checks({ legend: t('manage.client.claims.title'), name: 'claimType', choices: claimTypes.map((type) => ({ value: type.key, label: type.description ? `${type.key} (${type.description})` : type.key, checked: held.has(type.key) })) })}
<p><button type="submit">${escapeHtml(t('manage.client.claims.save'))}</button></p>
</form>`
    : `<p class="muted">${escapeHtml(t('manage.client.claims.none'))}</p>`
}
</div>`
        : ''

    const actions = editable
      ? `<div class="actions">
${client.type === 'confidential' ? link(`${hrefOf(client.clientId)}/rotate-secret`, t('manage.client.rotate'), 'button secondary') : ''}
${link(`${hrefOf(client.clientId)}/delete`, t('manage.client.delete'), 'button secondary')}
</div>`
      : ''

    const content = `<p>${link(BASE, `← ${t('manage.clients.back')}`)}</p>
<h1>${escapeHtml(client.name)}</h1>
<div class="panel">${facts}</div>
${settings}
${claims}
${actions}`
    const html = page(request, reply, session, SECTION, client.name, content)
    return reply.code(extra.status ?? 200).type('text/html').send(extra.error ? withAlert(html, extra.error) : html)
  }

  app.get<{ Params: { clientId: string } }>(`${BASE}/:clientId`, async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const { client, stop } = await load(request, reply, session, request.params.clientId)
    return client ? detail(request, reply, session, client) : stop
  })

  app.post<{ Params: { clientId: string }; Body: Record<string, unknown> }>(`${BASE}/:clientId`, async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const { client, stop } = await load(request, reply, session, request.params.clientId)
    if (!client) return stop
    const kind = kindOf(client)
    if (kind === 'system') return detail(request, reply, session, client, { error: viewFor(request, session).t('manage.client.system'), status: 409 })
    const { t } = viewFor(request, session)
    const values = { ...formFrom(request.body), type: client.type }

    const response = await api(request, session, { method: 'PATCH', url: `/clients/${encodeURIComponent(client.clientId)}`, body: payloadOf(kind, values) })
    if (response.statusCode === 401) return sessionEnded(reply)
    if (response.statusCode === 200) {
      const saved = response.json() as ApiClient
      return redirectWith(reply, hrefOf(client.clientId), saved.updatedAt === client.updatedAt ? { kind: 'ok', key: 'manage.client.unchanged' } : { kind: 'ok', key: 'manage.client.saved', values: { name: saved.name } })
    }
    if (response.statusCode === 404) return missing(request, reply, session)

    const body = jsonOf(response)
    return detail(request, reply, session, client, {
      form: values,
      errors: fieldErrors(body),
      error: response.statusCode === 400 ? t('manage.clientForm.invalid') : t('manage.clientForm.failed', { reason: problemText(body) }),
      status: response.statusCode === 400 ? 422 : response.statusCode,
    })
  })

  // --- The claim types a client receives

  app.post<{ Params: { clientId: string }; Body: Record<string, unknown> }>(`${BASE}/:clientId/claim-types`, async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const { client, stop } = await load(request, reply, session, request.params.clientId)
    if (!client) return stop
    const chosen = many(request.body, 'claimType')

    const response = await api(request, session, { method: 'PUT', url: `/clients/${encodeURIComponent(client.clientId)}/claim-types`, body: { claimTypes: chosen } })
    if (response.statusCode === 401) return sessionEnded(reply)
    if (response.statusCode === 200) return redirectWith(reply, hrefOf(client.clientId), { kind: 'ok', key: 'manage.client.claims.saved', values: { name: client.name } })
    return detail(request, reply, session, client, { claims: chosen, error: problemText(jsonOf(response)), status: response.statusCode === 400 ? 422 : response.statusCode })
  })

  // --- Replacing the secret and deleting: each asks first

  type Danger = 'rotate-secret' | 'delete'
  const confirmation = (request: FastifyRequest, reply: FastifyReply, session: ManageSession, client: ApiClient, action: Danger, problem?: { status: number; text: string; typed?: string }) => {
    const { t } = viewFor(request, session)
    const key = action === 'delete' ? 'delete' : 'rotate'
    const values = { name: client.name, id: client.clientId }
    const title = t(`manage.client.${key}.title`, values)
    const possible = kindOf(client) !== 'system' && (action === 'delete' || client.type === 'confidential')
    const body = possible
      ? `<p>${escapeHtml(t(`manage.client.${key}.text`))}</p>
<form class="fields" method="post" action="${hrefOf(client.clientId)}/${action}">
${action === 'delete' ? field({ id: 'confirmId', label: t('manage.client.delete.type', values), value: problem?.typed ?? '', required: true }) : ''}
<div class="submit"><button type="submit" class="danger">${escapeHtml(t(`manage.client.${key}`))}</button> ${link(hrefOf(client.clientId), t('manage.cancel'), 'button secondary')}</div>
</form>`
      : `<p>${escapeHtml(t('manage.client.system'))}</p>\n<p>${link(hrefOf(client.clientId), t('manage.cancel'), 'button')}</p>`
    const html = page(request, reply, session, SECTION, title, `<h1>${escapeHtml(title)}</h1>\n<div class="panel">${body}</div>`)
    return reply.code(problem?.status ?? 200).type('text/html').send(problem ? withAlert(html, problem.text) : html)
  }

  for (const action of ['rotate-secret', 'delete'] as const) {
    app.get<{ Params: { clientId: string } }>(`${BASE}/:clientId/${action}`, async (request, reply) => {
      const session = requireSession(request, reply)
      if (!session) return reply
      const { client, stop } = await load(request, reply, session, request.params.clientId)
      return client ? confirmation(request, reply, session, client, action) : stop
    })

    app.post<{ Params: { clientId: string }; Body: Record<string, unknown> }>(`${BASE}/:clientId/${action}`, async (request, reply) => {
      const session = requireSession(request, reply)
      if (!session) return reply
      const { client, stop } = await load(request, reply, session, request.params.clientId)
      if (!client) return stop
      const { t } = viewFor(request, session)
      const id = encodeURIComponent(client.clientId)

      if (action === 'delete') {
        const typed = text(request.body, 'confirmId')
        if (typed !== client.clientId) {
          return confirmation(request, reply, session, client, action, { status: 422, text: t('manage.client.delete.mismatch'), typed })
        }
      }

      const response = action === 'delete' ? await api(request, session, { method: 'DELETE', url: `/clients/${id}` }) : await api(request, session, { method: 'POST', url: `/clients/${id}/rotate-secret` })
      if (response.statusCode === 401) return sessionEnded(reply)
      if (response.statusCode >= 400) {
        return confirmation(request, reply, session, client, action, { status: response.statusCode < 600 ? response.statusCode : 502, text: problemText(jsonOf(response)) })
      }
      return action === 'delete'
        ? redirectWith(reply, BASE, { kind: 'ok', key: 'manage.client.deleted', values: { name: client.name } })
        : secretPage(request, reply, session, client, (response.json() as { clientSecret: string }).clientSecret)
    })
  }
}
