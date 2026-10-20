import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { escapeHtml } from '../ui/pages.js'
import { MANAGE_PATH } from './constants.js'
import type { ManageContext, ManageSession } from './context.js'
import { badge, checkbox, field, link, select, textarea } from './html.js'

const BASE = `${MANAGE_PATH}/users`
const STATUSES = ['created', 'active', 'locked', 'deactivated'] as const
/** What a search may be long: more is not a name, an e-mail address or a claim value. */
const MAX_SEARCH = 200
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface ApiUser {
  id: string
  email: string
  firstName: string
  lastName: string
  phone: string | null
  phoneVerifiedAt: string | null
  language: string
  status: (typeof STATUSES)[number]
  isAdmin: boolean
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

interface ClaimType {
  key: string
  description: string
  valuePattern: string | null
  multiValued: boolean
}

/** What a person typed into the profile form, kept so that a refused form comes back as it was filled in. */
interface ProfileForm {
  firstName: string
  lastName: string
  email: string
  phone: string
  language: string
  isAdmin: boolean
}

const fullName = (user: Pick<ApiUser, 'firstName' | 'lastName'>) => `${user.firstName} ${user.lastName}`.trim()
const text = (body: Record<string, unknown> | undefined, key: string) => (typeof body?.[key] === 'string' ? (body[key] as string).trim() : '')
const profileOf = (user: ApiUser): ProfileForm => ({
  firstName: user.firstName,
  lastName: user.lastName,
  email: user.email,
  phone: user.phone ?? '',
  language: user.language,
  isAdmin: user.isAdmin,
})
const profileFrom = (body: Record<string, unknown> | undefined): ProfileForm => ({
  firstName: text(body, 'firstName'),
  lastName: text(body, 'lastName'),
  email: text(body, 'email'),
  phone: text(body, 'phone'),
  language: text(body, 'language'),
  isAdmin: body?.isAdmin === 'on',
})

/** The users of pforte: find them, see everything about one, create and change them. */
export const registerUsers = (app: FastifyInstance, ctx: ManageContext) => {
  const { requireSession, api, page, viewFor, redirectWith, problemText, fieldErrors, formatTime, sessionEnded, ui } = ctx

  const notFound = (request: FastifyRequest, reply: FastifyReply, session: ManageSession) => {
    const { t } = viewFor(request, session)
    return reply
      .code(404)
      .type('text/html')
      .send(
        page(
          request,
          reply,
          session,
          'users',
          t('manage.notFound.title'),
          `<h1>${escapeHtml(t('manage.notFound.title'))}</h1>\n<p>${escapeHtml(t('manage.notFound.text'))}</p>\n<p>${link(BASE, t('manage.user.back'), 'button')}</p>`,
        ),
      )
  }

  const failed = (request: FastifyRequest, reply: FastifyReply, session: ManageSession, response: { statusCode: number; body: string }) => {
    const { t } = viewFor(request, session)
    let body: unknown
    try {
      body = JSON.parse(response.body)
    } catch {
      body = undefined
    }
    return reply
      .code(response.statusCode >= 400 && response.statusCode < 600 ? response.statusCode : 502)
      .type('text/html')
      .send(page(request, reply, session, 'users', t('manage.error.title'), `<h1>${escapeHtml(t('manage.error.title'))}</h1>\n<p>${escapeHtml(problemText(body))}</p>`))
  }

  const statusBadge = (t: ReturnType<typeof viewFor>['t'], status: ApiUser['status']) => badge(status, t(`manage.status.${status}`))

  // --- The list: search and filters, as a form that is a link

  app.get<{ Querystring: Record<string, string | undefined> }>(BASE, async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const { t, language } = viewFor(request, session)
    const q = request.query
    const filters = {
      search: (q.search ?? '').trim().slice(0, MAX_SEARCH),
      claimType: q.claimType ?? '',
      claimValue: (q.claimValue ?? '').trim().slice(0, MAX_SEARCH),
      status: (STATUSES as readonly string[]).includes(q.status ?? '') ? (q.status as string) : '',
    }

    const params = new URLSearchParams({ limit: '25' })
    if (filters.search) params.set('search', filters.search)
    if (filters.claimType && filters.claimValue) params.set('claim', `${filters.claimType}:${filters.claimValue}`)
    if (filters.status) params.set('status', filters.status)
    if (q.cursor && UUID.test(q.cursor)) params.set('cursor', q.cursor)

    const [list, types] = await Promise.all([api(request, session, { method: 'GET', url: `/users?${params}` }), api(request, session, { method: 'GET', url: '/claim-types' })])
    if (list.statusCode === 401 || types.statusCode === 401) return sessionEnded(reply)
    if (list.statusCode !== 200) return failed(request, reply, session, list)
    const { items, nextCursor } = list.json() as { items: ApiUser[]; nextCursor?: string }
    const claimTypes = types.statusCode === 200 ? (types.json().items as ClaimType[]) : []

    const keep = Object.entries(filters).filter(([, value]) => value)
    const next = nextCursor ? `${BASE}?${new URLSearchParams([...keep, ['cursor', nextCursor]])}` : undefined
    const filtering = keep.length > 0

    const form = `<form class="fields" method="get" action="${BASE}">
${field({ id: 'search', type: 'search', label: t('manage.users.search'), value: filters.search, maxLength: MAX_SEARCH })}
${select({ id: 'status', label: t('manage.users.status'), value: filters.status, choices: [{ value: '', label: t('manage.users.statusAny') }, ...STATUSES.map((status) => ({ value: status, label: t(`manage.status.${status}`) }))] })}
${
  claimTypes.length
    ? `${select({ id: 'claimType', label: t('manage.users.claimType'), value: filters.claimType, choices: [{ value: '', label: t('manage.users.claimAny') }, ...claimTypes.map((type) => ({ value: type.key, label: type.key }))] })}
${field({ id: 'claimValue', label: t('manage.users.claimValue'), value: filters.claimValue, maxLength: MAX_SEARCH })}`
    : ''
}
<div class="submit"><button type="submit">${escapeHtml(t('manage.users.find'))}</button> ${filtering ? link(BASE, t('manage.users.reset'), 'button secondary') : ''}</div>
</form>`

    const rows = items
      .map(
        (user) => `<tr>
<td>${link(`${BASE}/${user.id}`, fullName(user) || user.email)}${user.isAdmin ? ` ${badge('admin', t('manage.badge.admin'))}` : ''}</td>
<td>${escapeHtml(user.email)}</td>
<td>${statusBadge(t, user.status)}</td>
<td>${user.lastLoginAt ? escapeHtml(formatTime(user.lastLoginAt, language)) : `<span class="muted">${escapeHtml(t('manage.never'))}</span>`}</td>
</tr>`,
      )
      .join('\n')

    const content = `<h1>${escapeHtml(t('manage.users.title'))}</h1>
<div class="panel">${form}</div>
<div class="actions">${link(`${BASE}/new`, t('manage.users.new'), 'button')}</div>
${
  items.length
    ? `<div class="scroll"><table class="list">
<thead><tr><th>${escapeHtml(t('manage.users.name'))}</th><th>${escapeHtml(t('manage.users.email'))}</th><th>${escapeHtml(t('manage.users.status'))}</th><th>${escapeHtml(t('manage.users.lastSignIn'))}</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>`
    : `<p class="muted">${escapeHtml(t('manage.users.none'))}</p>`
}
${next ? `<div class="actions">${link(next, t('manage.users.more'), 'button secondary')}</div>` : ''}`

    return reply.type('text/html').send(page(request, reply, session, 'users', t('manage.users.title'), content))
  })

  // --- New user

  const createForm = (request: FastifyRequest, session: ManageSession, values: ProfileForm, errors: Record<string, string> = {}) => {
    const { t } = viewFor(request, session)
    return `<h1>${escapeHtml(t('manage.create.title'))}</h1>
<p>${link(BASE, `← ${t('manage.user.back')}`)}</p>
<div class="panel"><form class="fields" method="post" action="${BASE}">
${profileFields(t, values, errors, true)}
<div class="submit"><button type="submit">${escapeHtml(t('manage.create.submit'))}</button></div>
</form></div>`
  }

  const profileFields = (t: ReturnType<typeof viewFor>['t'], values: ProfileForm, errors: Record<string, string>, creating = false) => `${field({ id: 'firstName', label: t('manage.field.firstName'), value: values.firstName, error: errors.firstName, required: true, maxLength: 200 })}
${field({ id: 'lastName', label: t('manage.field.lastName'), value: values.lastName, error: errors.lastName, required: true, maxLength: 200 })}
${field({ id: 'email', type: 'email', label: t('manage.field.email'), value: values.email, error: errors.email, required: true })}
${field({ id: 'phone', type: 'tel', label: t('manage.field.phone'), value: values.phone, hint: t('manage.field.phoneHint'), error: errors.phone })}
${select({ id: 'language', label: t('manage.field.language'), value: values.language || (creating ? ui.i18n.defaultLanguage : ''), choices: [...new Set([...ui.i18n.languages, ...(values.language ? [values.language] : [])])].map((language) => ({ value: language, label: language })) })}
${checkbox({ id: 'isAdmin', label: t('manage.field.isAdmin'), checked: values.isAdmin })}`

  const emptyProfile = (): ProfileForm => ({ firstName: '', lastName: '', email: '', phone: '', language: ui.i18n.defaultLanguage, isAdmin: false })

  app.get(`${BASE}/new`, async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const { t } = viewFor(request, session)
    return reply.type('text/html').send(page(request, reply, session, 'users', t('manage.create.title'), createForm(request, session, emptyProfile())))
  })

  app.post<{ Body: Record<string, unknown> }>(BASE, async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const { t } = viewFor(request, session)
    const values = profileFrom(request.body)

    const response = await api(request, session, {
      method: 'POST',
      url: '/users',
      body: {
        email: values.email,
        firstName: values.firstName,
        lastName: values.lastName,
        ...(values.phone ? { phone: values.phone } : {}),
        ...(values.language ? { language: values.language } : {}),
        ...(values.isAdmin ? { isAdmin: true } : {}),
      },
    })
    if (response.statusCode === 401) return sessionEnded(reply)
    if (response.statusCode === 201) {
      const user = response.json() as ApiUser
      return redirectWith(reply, `${BASE}/${user.id}`, { kind: 'ok', key: 'manage.create.created', values: { name: fullName(user) || user.email } })
    }

    const body = response.json()
    const errors = fieldErrors(body)
    const flash = response.statusCode === 400 ? t('manage.form.invalid') : t('manage.form.failed', { reason: problemText(body) })
    return reply
      .code(response.statusCode === 400 ? 422 : response.statusCode)
      .type('text/html')
      .send(withFlash(page(request, reply, session, 'users', t('manage.create.title'), createForm(request, session, values, errors)), flash))
  })

  /** Puts an error message above the content of a page that was rendered without one. */
  const withFlash = (html: string, message: string) => html.replace('<main class="page" id="content">', `<main class="page" id="content">\n<p class="flash error" role="alert">${escapeHtml(message)}</p>`)

  // --- One user

  const detail = async (
    request: FastifyRequest,
    reply: FastifyReply,
    session: ManageSession,
    user: ApiUser,
    extra: { profile?: ProfileForm; errors?: Record<string, string>; claimValues?: Record<string, string>; claimError?: string; error?: string; status?: number } = {},
  ) => {
    const { t, language } = viewFor(request, session)
    const [claims, types] = await Promise.all([api(request, session, { method: 'GET', url: `/users/${user.id}/claims` }), api(request, session, { method: 'GET', url: '/claim-types' })])
    if (claims.statusCode === 401 || types.statusCode === 401) return sessionEnded(reply)
    const held = (claims.statusCode === 200 ? claims.json().claims : {}) as Record<string, string[]>
    const claimTypes = types.statusCode === 200 ? (types.json().items as ClaimType[]) : []

    const facts = `<dl class="facts">
<dt>${escapeHtml(t('manage.fact.status'))}</dt><dd>${statusBadge(t, user.status)}${user.isAdmin ? ` ${badge('admin', t('manage.badge.admin'))}` : ''}</dd>
<dt>${escapeHtml(t('manage.fact.lastSignIn'))}</dt><dd>${user.lastLoginAt ? escapeHtml(formatTime(user.lastLoginAt, language)) : escapeHtml(t('manage.never'))}</dd>
<dt>${escapeHtml(t('manage.fact.created'))}</dt><dd>${escapeHtml(formatTime(user.createdAt, language))}</dd>
<dt>${escapeHtml(t('manage.fact.email'))}</dt><dd>${escapeHtml(t(user.status === 'created' ? 'manage.no' : 'manage.yes'))}</dd>
<dt>${escapeHtml(t('manage.fact.phone'))}</dt><dd>${user.phone ? escapeHtml(t(user.phoneVerifiedAt ? 'manage.yes' : 'manage.no')) : escapeHtml(t('manage.none'))}</dd>
</dl>`

    const claimFields = claimTypes.length
      ? claimTypes
          .map((type) => {
            const values = extra.claimValues?.[type.key] ?? (held[type.key] ?? []).join('\n')
            const hint = [type.description, type.valuePattern ? t('manage.claims.format', { pattern: type.valuePattern }) : ''].filter(Boolean).join(' · ')
            return type.multiValued
              ? textarea({ id: `claim_${type.key}`, label: type.key, value: values, hint, rows: Math.max(2, values.split('\n').length + 1) })
              : field({ id: `claim_${type.key}`, label: type.key, value: values, hint })
          })
          .join('\n')
      : `<p class="muted">${escapeHtml(t('manage.claims.none'))}</p>`

    const content = `<p>${link(BASE, `← ${t('manage.user.back')}`)}</p>
<h1>${escapeHtml(fullName(user) || user.email)}</h1>
<div class="panel">${facts}</div>

<h2>${escapeHtml(t('manage.user.profile'))}</h2>
<div class="panel"><form class="fields" method="post" action="${BASE}/${user.id}">
${profileFields(t, extra.profile ?? profileOf(user), extra.errors ?? {})}
<div class="submit"><button type="submit">${escapeHtml(t('manage.user.save'))}</button></div>
</form></div>

<h2>${escapeHtml(t('manage.claims.title'))}</h2>
<div class="panel">
<p class="muted">${escapeHtml(t('manage.claims.help'))}</p>
${extra.claimError ? `<p class="flash error" role="alert">${escapeHtml(extra.claimError)}</p>` : ''}
<form method="post" action="${BASE}/${user.id}/claims">
${claimFields}
${claimTypes.length ? `<p><button type="submit">${escapeHtml(t('manage.claims.save'))}</button></p>` : ''}
</form>
</div>`

    const html = page(request, reply, session, 'users', fullName(user) || user.email, content)
    return reply.code(extra.status ?? 200).type('text/html').send(extra.error ? withFlash(html, extra.error) : html)
  }

  const loadUser = async (request: FastifyRequest, reply: FastifyReply, session: ManageSession, id: string) => {
    if (!UUID.test(id)) return { response: notFound(request, reply, session) }
    const response = await api(request, session, { method: 'GET', url: `/users/${id}` })
    if (response.statusCode === 401) return { response: sessionEnded(reply) }
    if (response.statusCode === 404) return { response: notFound(request, reply, session) }
    if (response.statusCode !== 200) return { response: failed(request, reply, session, response) }
    return { user: response.json() as ApiUser }
  }

  app.get<{ Params: { id: string } }>(`${BASE}/:id`, async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const { user, response } = await loadUser(request, reply, session, request.params.id)
    return user ? detail(request, reply, session, user) : response
  })

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(`${BASE}/:id`, async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const { user, response: stop } = await loadUser(request, reply, session, request.params.id)
    if (!user) return stop
    const { t } = viewFor(request, session)
    const values = profileFrom(request.body)

    const response = await api(request, session, {
      method: 'PATCH',
      url: `/users/${user.id}`,
      body: {
        firstName: values.firstName,
        lastName: values.lastName,
        email: values.email,
        phone: values.phone || null,
        ...(values.language ? { language: values.language } : {}),
        isAdmin: values.isAdmin,
      },
    })
    if (response.statusCode === 401) return sessionEnded(reply)
    if (response.statusCode === 200) {
      const saved = response.json() as ApiUser
      return redirectWith(
        reply,
        `${BASE}/${user.id}`,
        saved.updatedAt === user.updatedAt ? { kind: 'ok', key: 'manage.user.unchanged' } : { kind: 'ok', key: 'manage.user.saved', values: { name: fullName(saved) || saved.email } },
      )
    }
    if (response.statusCode === 404) return notFound(request, reply, session)

    const body = response.json()
    return detail(request, reply, session, user, {
      profile: values,
      errors: fieldErrors(body),
      error: response.statusCode === 400 ? t('manage.form.invalid') : t('manage.form.failed', { reason: problemText(body) }),
      status: response.statusCode === 400 ? 422 : response.statusCode,
    })
  })

  // --- The claims of a user

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(`${BASE}/:id/claims`, async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const { user, response: stop } = await loadUser(request, reply, session, request.params.id)
    if (!user) return stop

    const types = await api(request, session, { method: 'GET', url: '/claim-types' })
    if (types.statusCode === 401) return sessionEnded(reply)
    const claimTypes = (types.statusCode === 200 ? types.json().items : []) as ClaimType[]

    const typed: Record<string, string> = {}
    const claims: Record<string, string[]> = {}
    for (const type of claimTypes) {
      const raw = typeof request.body?.[`claim_${type.key}`] === 'string' ? (request.body[`claim_${type.key}`] as string) : ''
      typed[type.key] = raw
      claims[type.key] = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    }

    const response = await api(request, session, { method: 'PUT', url: `/users/${user.id}/claims`, body: { claims } })
    if (response.statusCode === 401) return sessionEnded(reply)
    if (response.statusCode === 200) {
      return redirectWith(reply, `${BASE}/${user.id}`, response.json().changed ? { kind: 'ok', key: 'manage.claims.saved', values: { name: fullName(user) || user.email } } : { kind: 'ok', key: 'manage.user.unchanged' })
    }
    return detail(request, reply, session, user, { claimValues: typed, claimError: problemText(response.json()), status: response.statusCode === 400 ? 422 : response.statusCode })
  })
}
