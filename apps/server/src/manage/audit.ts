import type { FastifyInstance, FastifyRequest } from 'fastify'
import { escapeHtml } from '../ui/pages.js'
import { createCommon } from './common.js'
import { MANAGE_PATH } from './constants.js'
import type { ManageContext, ManageSession } from './context.js'
import { field, link } from './html.js'

const BASE = `${MANAGE_PATH}/audit`
const SECTION = 'audit'
const PAGE_SIZE = 50
/** What a filter may be long: more is not an address, an ID or an action. */
const MAX_FILTER = 200
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY = /^\d{4}-\d{2}-\d{2}$/
/** Suggestions for the action filter: every action pforte records. */
const KNOWN_ACTIONS = [
  'login.*', 'login.succeeded', 'login.password_failed', 'login.code_sent', 'login.code_failed', 'login.blocked',
  'user.*', 'user.create', 'user.update', 'user.delete', 'user.lock', 'user.unlock', 'user.activate', 'user.deactivate',
  'user.password_reset.request', 'user.password_reset.complete', 'user.sessions.end', 'user.device.revoke', 'user.devices.revoke', 'user.claims.set',
  'client.*', 'client.create', 'client.update', 'client.delete', 'client.rotate_secret', 'client.claim_types.set',
  'claim_type.*', 'claim_type.create', 'claim_type.update', 'claim_type.delete',
]

interface AuditEvent {
  id: string
  createdAt: string
  actorType: 'user' | 'client' | 'system'
  actorId: string | null
  action: string
  targetType: string | null
  targetId: string | null
  details: Record<string, unknown>
  ip: string | null
  userAgent: string | null
}

interface Person {
  id: string
  email: string
  firstName: string
  lastName: string
}

const personName = (person: Person) => `${person.firstName} ${person.lastName}`.trim() || person.email

/** The instant a calendar day starts in a time zone, from a `YYYY-MM-DD` date. */
const dayStart = (day: string, timeZone: string) => {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  const guess = Date.UTC(year, month - 1, date)
  if (new Date(guess).getUTCDate() !== date) return undefined
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(guess))
    const part = (type: string) => Number(parts.find((item) => item.type === type)?.value)
    const asLocal = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'))
    return new Date(guess - (asLocal - guess))
  } catch {
    return undefined
  }
}

const nextDay = (day: string) => {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10)
}

/** What happened and who it happened to: the audit log, read-only. */
export const registerAudit = (app: FastifyInstance, ctx: ManageContext) => {
  const { requireSession, api, page, viewFor, formatTime, sessionEnded, timeZone } = ctx
  const { failed } = createCommon(ctx)

  /** The person with this e-mail address, if there is one. */
  const findPerson = async (request: FastifyRequest, session: ManageSession, email: string) => {
    const response = await api(request, session, { method: 'GET', url: `/users?${new URLSearchParams({ search: email, limit: '10' })}` })
    if (response.statusCode === 401) return 'ended' as const
    if (response.statusCode !== 200) return undefined
    return (response.json().items as Person[]).find((person) => person.email.toLowerCase() === email.toLowerCase())
  }

  app.get<{ Querystring: Record<string, string | undefined> }>(BASE, async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const { t, language } = viewFor(request, session)
    const q = request.query
    const filters = {
      user: (q.user ?? '').trim().slice(0, MAX_FILTER),
      actor: (q.actor ?? '').trim().slice(0, MAX_FILTER),
      action: (q.action ?? '').trim().slice(0, MAX_FILTER),
      from: DAY.test(q.from ?? '') ? (q.from as string) : '',
      to: DAY.test(q.to ?? '') ? (q.to as string) : '',
    }

    const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
    const problems: string[] = []
    let empty = false

    if (filters.user) {
      const person = await findPerson(request, session, filters.user)
      if (person === 'ended') return sessionEnded(reply)
      if (person) {
        params.set('targetType', 'user')
        params.set('targetId', person.id)
      } else {
        problems.push(t('manage.audit.noPerson', { email: filters.user }))
        empty = true
      }
    }
    if (filters.actor) {
      if (filters.actor.includes('@')) {
        const person = await findPerson(request, session, filters.actor)
        if (person === 'ended') return sessionEnded(reply)
        if (person) {
          params.set('actorType', 'user')
          params.set('actorId', person.id)
        } else {
          problems.push(t('manage.audit.noPerson', { email: filters.actor }))
          empty = true
        }
      } else {
        params.set('actorType', 'client')
        params.set('actorId', filters.actor)
      }
    }
    if (filters.action) params.set('action', filters.action)
    const from = filters.from ? dayStart(filters.from, timeZone) : undefined
    const until = filters.to ? dayStart(nextDay(filters.to), timeZone) : undefined
    if (from) params.set('from', from.toISOString())
    if (until) params.set('to', until.toISOString())
    if (q.cursor && UUID.test(q.cursor)) params.set('cursor', q.cursor)

    let events: AuditEvent[] = []
    let nextCursor: string | undefined
    if (!empty) {
      const response = await api(request, session, { method: 'GET', url: `/audit-events?${params}` })
      if (response.statusCode === 401) return sessionEnded(reply)
      if (response.statusCode !== 200) return failed(request, reply, session, SECTION, response)
      ;({ items: events, nextCursor } = response.json() as { items: AuditEvent[]; nextCursor?: string })
    }

    // Who the people in these events are: names instead of IDs. A deleted person is known only from the event itself.
    const ids = new Set<string>()
    for (const event of events) {
      if (event.actorType === 'user' && event.actorId) ids.add(event.actorId)
      if (event.targetType === 'user' && event.targetId) ids.add(event.targetId)
    }
    const people = new Map<string, Person>()
    await Promise.all(
      [...ids].filter((id) => UUID.test(id)).map(async (id) => {
        const response = await api(request, session, { method: 'GET', url: `/users/${id}` })
        if (response.statusCode === 200) people.set(id, response.json() as Person)
      }),
    )

    const personCell = (id: string, snapshot?: unknown) => {
      const person = people.get(id)
      if (person) return `${link(`${MANAGE_PATH}/users/${id}`, personName(person))}<br><small class="muted">${escapeHtml(person.email)}</small>`
      return `${typeof snapshot === 'string' ? escapeHtml(snapshot) : ''} <span class="muted">(${escapeHtml(t('manage.audit.deleted'))})</span>`
    }
    const actorCell = (event: AuditEvent) => {
      if (event.actorType === 'system') return `<span class="muted">${escapeHtml(t('manage.audit.system'))}</span>`
      if (!event.actorId) return `<span class="muted">${escapeHtml(t('manage.audit.anonymous'))}</span>`
      return event.actorType === 'user' ? personCell(event.actorId) : `<code>${escapeHtml(event.actorId)}</code>`
    }
    const targetCell = (event: AuditEvent) => {
      if (!event.targetType || !event.targetId) return ''
      if (event.targetType === 'user') return personCell(event.targetId, event.details.email)
      const href = event.targetType === 'client' ? `${MANAGE_PATH}/clients/${encodeURIComponent(event.targetId)}` : event.targetType === 'claim_type' ? `${MANAGE_PATH}/claim-types/${encodeURIComponent(event.targetId)}` : undefined
      return `${escapeHtml(event.targetType)}: ${href ? link(href, event.targetId) : `<code>${escapeHtml(event.targetId)}</code>`}`
    }

    /** One event: its columns are the summary, and what was recorded opens below them, across the whole width. */
    const eventRow = (event: AuditEvent) => {
      const columns = `<span class="nowrap">${escapeHtml(formatTime(event.createdAt, language, { seconds: true }))}</span>
<span>${actorCell(event)}</span>
<span><code>${escapeHtml(event.action)}</code></span>
<span>${targetCell(event)}</span>
<span>${escapeHtml(event.ip ?? '')}</span>`
      if (Object.keys(event.details).length === 0 && !event.userAgent) return `<div class="event"><div class="cols">${columns}</div></div>`
      return `<details class="event">
<summary class="cols" aria-label="${escapeHtml(t('manage.audit.details'))}">${columns}</summary>
<div class="body"><pre>${escapeHtml(JSON.stringify(event.details, null, 2))}</pre>${event.userAgent ? `<p class="muted">${escapeHtml(t('manage.audit.browser'))}: ${escapeHtml(event.userAgent)}</p>` : ''}</div>
</details>`
    }

    const keep = Object.entries(filters).filter(([, value]) => value)
    const older = nextCursor ? `${BASE}?${new URLSearchParams([...keep, ['cursor', nextCursor]])}` : undefined

    const form = `<form class="fields" method="get" action="${BASE}">
${field({ id: 'user', type: 'search', label: t('manage.audit.user'), value: filters.user, hint: t('manage.audit.userHint'), maxLength: MAX_FILTER })}
${field({ id: 'actor', type: 'search', label: t('manage.audit.actor'), value: filters.actor, hint: t('manage.audit.actorHint'), maxLength: MAX_FILTER })}
${field({ id: 'action', type: 'search', label: t('manage.audit.action'), value: filters.action, hint: t('manage.audit.actionHint'), list: 'known-actions', maxLength: MAX_FILTER })}
<datalist id="known-actions">${KNOWN_ACTIONS.map((action) => `<option value="${escapeHtml(action)}"></option>`).join('')}</datalist>
${field({ id: 'from', type: 'date', label: t('manage.audit.from'), value: filters.from })}
${field({ id: 'to', type: 'date', label: t('manage.audit.to'), value: filters.to })}
<div class="submit"><button type="submit">${escapeHtml(t('manage.audit.find'))}</button> ${keep.length ? link(BASE, t('manage.audit.reset'), 'button secondary') : ''}</div>
</form>`

    const content = `<h1>${escapeHtml(t('manage.audit.title'))}</h1>
<p class="muted">${escapeHtml(t('manage.audit.intro'))}</p>
<div class="panel">${form}</div>
${problems.map((problem) => `<p class="flash error" role="alert">${escapeHtml(problem)}</p>`).join('\n')}
${
  events.length
    ? `<div class="events">
<div class="cols head"><span>${escapeHtml(t('manage.audit.when'))}</span><span>${escapeHtml(t('manage.audit.who'))}</span><span>${escapeHtml(t('manage.audit.what'))}</span><span>${escapeHtml(t('manage.audit.target'))}</span><span>${escapeHtml(t('manage.audit.address'))}</span></div>
${events.map(eventRow).join('\n')}
</div>`
    : empty
      ? ''
      : `<p class="muted">${escapeHtml(t('manage.audit.none'))}</p>`
}
${older ? `<div class="actions">${link(older, t('manage.audit.more'), 'button secondary')}</div>` : ''}`

    return reply.type('text/html').send(page(request, reply, session, SECTION, t('manage.audit.title'), content))
  })
}
