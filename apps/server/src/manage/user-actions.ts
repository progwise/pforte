import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { MessageKey } from '../i18n/index.js'
import { escapeHtml } from '../ui/pages.js'
import { MANAGE_PATH } from './constants.js'
import type { ManageContext, ManageSession } from './context.js'
import { badge, field, link } from './html.js'

const BASE = `${MANAGE_PATH}/users`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Status = 'created' | 'active' | 'locked' | 'deactivated'

export interface ActionUser {
  id: string
  email: string
  firstName: string
  lastName: string
  status: Status
}

/** The actions on a user: what the API calls them, when they are possible, and the texts of their pages. */
const ACTIONS = {
  lock: { api: 'lock', from: ['created', 'active'], label: 'manage.action.lock' },
  unlock: { api: 'unlock', from: ['locked'], label: 'manage.action.unlock' },
  activate: { api: 'activate', from: ['created'], label: 'manage.action.activate' },
  reactivate: { api: 'activate', from: ['deactivated'], label: 'manage.action.reactivate' },
  deactivate: { api: 'deactivate', from: ['created', 'active', 'locked'], label: 'manage.action.deactivate' },
  'reset-password': { api: 'reset-password', from: ['active'], label: 'manage.action.resetPassword' },
  'end-sessions': { api: 'end-sessions', from: ['created', 'active', 'locked', 'deactivated'], label: 'manage.action.endSessions' },
  delete: { api: undefined, from: ['created', 'active', 'locked', 'deactivated'], label: 'manage.action.delete' },
} as const satisfies Record<string, { api: string | undefined; from: readonly Status[]; label: MessageKey }>

type ActionName = keyof typeof ACTIONS
const isAction = (name: string): name is ActionName => Object.hasOwn(ACTIONS, name)
const DANGEROUS: readonly ActionName[] = ['deactivate', 'delete', 'lock']

/** `camelCase` of an action name, for the text keys: `reset-password` is `resetPassword`. */
const textKey = (name: ActionName) => name.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase())

const fullName = (user: Pick<ActionUser, 'firstName' | 'lastName' | 'email'>) => `${user.firstName} ${user.lastName}`.trim() || user.email

/** The actions on the detail page of a user: a button for each that is possible in the status. */
export const actionButtons = (user: ActionUser, t: (key: MessageKey) => string) => {
  const buttons = (Object.keys(ACTIONS) as ActionName[])
    .filter((name) => (ACTIONS[name].from as readonly Status[]).includes(user.status))
    .map((name) => link(`${BASE}/${user.id}/${name}`, t(ACTIONS[name].label), DANGEROUS.includes(name) ? 'button secondary' : 'button'))
  return `<div class="actions">${buttons.join('\n')}</div>`
}

export const registerUserActions = (app: FastifyInstance, ctx: ManageContext) => {
  const { requireSession, api, page, viewFor, redirectWith, problemText, sessionEnded } = ctx

  const notFound = (request: FastifyRequest, reply: FastifyReply, session: ManageSession) => {
    const { t } = viewFor(request, session)
    return reply
      .code(404)
      .type('text/html')
      .send(
        page(request, reply, session, 'users', t('manage.notFound.title'), `<h1>${escapeHtml(t('manage.notFound.title'))}</h1>\n<p>${escapeHtml(t('manage.notFound.text'))}</p>\n<p>${link(BASE, t('manage.user.back'), 'button')}</p>`),
      )
  }

  const confirmation = (request: FastifyRequest, reply: FastifyReply, session: ManageSession, user: ActionUser, name: ActionName, problem?: { status: number; text: string; typed?: string }) => {
    const { t } = viewFor(request, session)
    const key = textKey(name)
    const values = { name: fullName(user), email: user.email, status: t(`manage.status.${user.status}`) }
    const possible = (ACTIONS[name].from as readonly Status[]).includes(user.status)
    const title = t(`manage.confirm.${key}.title` as MessageKey, values)

    const body = possible
      ? `<p>${escapeHtml(t(`manage.confirm.${key}.text` as MessageKey, values))}</p>
<form class="fields" method="post" action="${BASE}/${user.id}/${name}">
${name === 'delete' ? field({ id: 'confirmEmail', type: 'email', label: t('manage.confirm.delete.type', values), value: problem?.typed ?? '', required: true }) : ''}
<div class="submit"><button type="submit">${escapeHtml(t(ACTIONS[name].label))}</button> ${link(`${BASE}/${user.id}`, t('manage.cancel'), 'button secondary')}</div>
</form>`
      : `<p>${escapeHtml(t('manage.confirm.notPossible', values))}</p>\n<p>${link(`${BASE}/${user.id}`, t('manage.cancel'), 'button')}</p>`

    const html = page(request, reply, session, 'users', title, `<h1>${escapeHtml(title)}</h1>\n<div class="panel">${body}</div>`)
    return reply
      .code(problem?.status ?? 200)
      .type('text/html')
      .send(problem ? html.replace('<main class="page" id="content">', `<main class="page" id="content">\n<p class="flash error" role="alert">${escapeHtml(problem.text)}</p>`) : html)
  }

  const load = async (request: FastifyRequest<{ Params: { id: string; action: string } }>, reply: FastifyReply, session: ManageSession) => {
    const { id, action } = request.params
    if (!UUID.test(id) || !isAction(action)) return { stop: notFound(request, reply, session) }
    const response = await api(request, session, { method: 'GET', url: `/users/${id}` })
    if (response.statusCode === 401) return { stop: sessionEnded(reply) }
    if (response.statusCode !== 200) return { stop: notFound(request, reply, session) }
    return { user: response.json() as ActionUser, action }
  }

  app.get<{ Params: { id: string; action: string } }>(`${BASE}/:id/:action`, async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const { user, action, stop } = await load(request, reply, session)
    return user ? confirmation(request, reply, session, user, action) : stop
  })

  app.post<{ Params: { id: string; action: string }; Body: Record<string, unknown> }>(`${BASE}/:id/:action`, async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const { user, action, stop } = await load(request, reply, session)
    if (!user) return stop
    const { t } = viewFor(request, session)
    const name = fullName(user)

    if (action === 'delete') {
      const typed = typeof request.body?.confirmEmail === 'string' ? request.body.confirmEmail.trim() : ''
      if (typed.toLowerCase() !== user.email.toLowerCase()) {
        return confirmation(request, reply, session, user, action, { status: 422, text: t('manage.confirm.delete.mismatch'), typed })
      }
    }

    const response =
      action === 'delete'
        ? await api(request, session, { method: 'DELETE', url: `/users/${user.id}` })
        : await api(request, session, { method: 'POST', url: `/users/${user.id}/${ACTIONS[action].api}` })
    if (response.statusCode === 401) return sessionEnded(reply)
    if (response.statusCode >= 400) {
      let body: unknown
      try {
        body = response.json()
      } catch {
        body = undefined
      }
      return confirmation(request, reply, session, user, action, { status: response.statusCode < 600 ? response.statusCode : 502, text: problemText(body) })
    }

    if (action === 'delete') return redirectWith(reply, BASE, { kind: 'ok', key: 'manage.flash.deleted', values: { name } })
    const result = response.json()
    switch (action) {
      case 'lock':
        return redirectWith(reply, `${BASE}/${user.id}`, { kind: 'ok', key: 'manage.flash.locked', values: { name } })
      case 'unlock':
        return redirectWith(reply, `${BASE}/${user.id}`, { kind: 'ok', key: 'manage.flash.unlocked', values: { name } })
      case 'activate':
      case 'reactivate':
        return redirectWith(reply, `${BASE}/${user.id}`, result.activation?.linkSent ? { kind: 'ok', key: 'manage.flash.activated', values: { email: user.email } } : { kind: 'ok', key: 'manage.flash.reactivated', values: { name } })
      case 'deactivate':
        return redirectWith(reply, `${BASE}/${user.id}`, { kind: 'ok', key: 'manage.flash.deactivated', values: { name } })
      case 'reset-password':
        return redirectWith(reply, `${BASE}/${user.id}`, { kind: 'ok', key: 'manage.flash.resetSent', values: { name } })
      case 'end-sessions':
        return redirectWith(reply, `${BASE}/${user.id}`, { kind: 'ok', key: 'manage.flash.endedSessions', values: { name, sessions: String(result.sessionsEnded), devices: String(result.devicesRevoked) } })
    }
  })

  // --- Remembered devices: revoking one or all needs no confirmation, the person only gets asked for a code again

  app.post<{ Params: { id: string; device: string } }>(`${BASE}/:id/devices/:device/revoke`, async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const { id, device } = request.params
    if (!UUID.test(id) || !UUID.test(device)) return notFound(request, reply, session)
    const response = await api(request, session, { method: 'DELETE', url: `/users/${id}/devices/${device}` })
    if (response.statusCode === 401) return sessionEnded(reply)
    if (response.statusCode === 404) return notFound(request, reply, session)
    if (response.statusCode >= 400) return redirectWith(reply, `${BASE}/${id}`, { kind: 'error', text: problemText(response.json()) })
    return redirectWith(reply, `${BASE}/${id}`, { kind: 'ok', key: 'manage.flash.deviceRevoked' })
  })

  app.post<{ Params: { id: string } }>(`${BASE}/:id/devices-revoke-all`, async (request, reply) => {
    const session = requireSession(request, reply)
    if (!session) return reply
    const { id } = request.params
    if (!UUID.test(id)) return notFound(request, reply, session)
    const response = await api(request, session, { method: 'DELETE', url: `/users/${id}/devices` })
    if (response.statusCode === 401) return sessionEnded(reply)
    if (response.statusCode === 404) return notFound(request, reply, session)
    if (response.statusCode >= 400) return redirectWith(reply, `${BASE}/${id}`, { kind: 'error', text: problemText(response.json()) })
    return redirectWith(reply, `${BASE}/${id}`, { kind: 'ok', key: 'manage.flash.devicesRevoked', values: { count: String(response.json().devicesRevoked) } })
  })
}

// --- The panels on the detail page

interface Device {
  id: string
  userAgent: string | null
  lastSeenAt: string
  expiresAt: string
}
interface Application {
  clientId: string
  name: string
}
interface SessionInfo {
  startedAt: string
  expiresAt: string | null
  acr: string | null
  applications: Application[]
}
interface Grant extends Application {
  since: string
  expiresAt: string | null
}
interface AuditEvent {
  createdAt: string
  action: string
  details: Record<string, unknown>
  ip: string | null
}

const MFA = 'urn:pforte:acr:mfa'

/** A sign-in event in words. */
const eventText = (event: AuditEvent, t: (key: MessageKey) => string) => {
  const { method, channel } = event.details as { method?: string; channel?: string }
  const via = channel === 'sms' ? ` ${t('manage.event.sms')}` : channel === 'email' ? ` ${t('manage.event.email')}` : ''
  switch (event.action) {
    case 'login.succeeded':
      return method === 'remembered_device' ? t('manage.event.succeeded.device') : method === 'code' ? `${t('manage.event.succeeded.code')}${via}` : t('manage.event.succeeded')
    case 'login.password_failed':
      return event.details.reason === 'not_allowed' ? t('manage.event.notAllowed') : t('manage.event.passwordFailed')
    case 'login.code_failed':
      return t('manage.event.codeFailed')
    case 'login.code_sent':
      return `${t('manage.event.codeSent')}${via}`
    case 'login.blocked':
      return t('manage.event.blocked')
    default:
      return event.action
  }
}

/** Remembered devices, where the person is signed in, and the last sign-ins: what an administrator looks at when somebody reports a problem. */
export const userPanels = async (ctx: ManageContext, request: FastifyRequest, session: ManageSession, user: ActionUser) => {
  const { api, viewFor, formatTime } = ctx
  const { t, language } = viewFor(request, session)
  const [devices, sessions, events] = await Promise.all([
    api(request, session, { method: 'GET', url: `/users/${user.id}/devices` }),
    api(request, session, { method: 'GET', url: `/users/${user.id}/sessions` }),
    api(request, session, { method: 'GET', url: `/audit-events?${new URLSearchParams({ targetType: 'user', targetId: user.id, action: 'login.*', limit: '10' })}` }),
  ])
  const time = (iso: string | null) => (iso ? escapeHtml(formatTime(iso, language)) : '')

  const deviceItems = devices.statusCode === 200 ? (devices.json().items as Device[]) : undefined
  const devicePanel = deviceItems
    ? `<h2>${escapeHtml(t('manage.devices.title'))}</h2>
<div class="panel">
<p class="muted">${escapeHtml(t('manage.devices.help'))}</p>
${
  deviceItems.length
    ? `<div class="scroll"><table class="list">
<thead><tr><th>${escapeHtml(t('manage.devices.browser'))}</th><th>${escapeHtml(t('manage.devices.lastSeen'))}</th><th>${escapeHtml(t('manage.devices.until'))}</th><th></th></tr></thead>
<tbody>
${deviceItems
  .map(
    (device) => `<tr><td>${escapeHtml(device.userAgent ?? t('manage.devices.unknown'))}</td><td>${time(device.lastSeenAt)}</td><td>${time(device.expiresAt)}</td>
<td><form method="post" action="${BASE}/${user.id}/devices/${device.id}/revoke"><button type="submit" class="secondary">${escapeHtml(t('manage.devices.revoke'))}</button></form></td></tr>`,
  )
  .join('\n')}
</tbody></table></div>
<form method="post" action="${BASE}/${user.id}/devices-revoke-all"><button type="submit" class="secondary">${escapeHtml(t('manage.devices.revokeAll'))}</button></form>`
    : `<p class="muted">${escapeHtml(t('manage.devices.none'))}</p>`
}
</div>`
    : ''

  const signedIn = sessions.statusCode === 200 ? (sessions.json() as { sessions: SessionInfo[]; grants: Grant[] }) : undefined
  const sessionPanel = signedIn
    ? `<h2>${escapeHtml(t('manage.sessions.title'))}</h2>
<div class="panel">
<p class="muted">${escapeHtml(t('manage.sessions.help'))}</p>
${
  signedIn.sessions.length || signedIn.grants.length
    ? `${
        signedIn.sessions.length
          ? `<div class="scroll"><table class="list">
<thead><tr><th>${escapeHtml(t('manage.sessions.browsers'))}</th><th>${escapeHtml(t('manage.sessions.started'))}</th><th>${escapeHtml(t('manage.sessions.until'))}</th><th>${escapeHtml(t('manage.sessions.applications'))}</th></tr></thead>
<tbody>
${signedIn.sessions
  .map(
    (info) =>
      `<tr><td>${info.acr === MFA ? badge('active', t('manage.sessions.code')) : ''}</td><td>${time(info.startedAt)}</td><td>${time(info.expiresAt)}</td><td>${info.applications.length ? info.applications.map((application) => escapeHtml(application.name)).join(', ') : `<span class="muted">${escapeHtml(t('manage.sessions.noApplications'))}</span>`}</td></tr>`,
  )
  .join('\n')}
</tbody></table></div>`
          : ''
      }${
        signedIn.grants.length
          ? `<h3>${escapeHtml(t('manage.sessions.grants'))}</h3>
<div class="scroll"><table class="list">
<thead><tr><th>${escapeHtml(t('manage.sessions.applications'))}</th><th>${escapeHtml(t('manage.sessions.since'))}</th><th>${escapeHtml(t('manage.sessions.until'))}</th></tr></thead>
<tbody>
${signedIn.grants.map((grant) => `<tr><td>${escapeHtml(grant.name)}</td><td>${time(grant.since)}</td><td>${time(grant.expiresAt)}</td></tr>`).join('\n')}
</tbody></table></div>`
          : ''
      }`
    : `<p class="muted">${escapeHtml(t('manage.sessions.none'))}</p>`
}
</div>`
    : ''

  const recent = events.statusCode === 200 ? (events.json().items as AuditEvent[]) : undefined
  const signInPanel = recent
    ? `<h2>${escapeHtml(t('manage.signins.title'))}</h2>
<div class="panel">
${
  recent.length
    ? `<div class="scroll"><table class="list">
<thead><tr><th>${escapeHtml(t('manage.signins.when'))}</th><th>${escapeHtml(t('manage.signins.what'))}</th><th>${escapeHtml(t('manage.signins.from'))}</th></tr></thead>
<tbody>
${recent.map((event) => `<tr><td>${time(event.createdAt)}</td><td>${escapeHtml(eventText(event, t))}</td><td>${escapeHtml(event.ip ?? '')}</td></tr>`).join('\n')}
</tbody></table></div>`
    : `<p class="muted">${escapeHtml(t('manage.signins.none'))}</p>`
}
<p>${link(`${MANAGE_PATH}/audit?${new URLSearchParams({ user: user.email })}`, t('manage.audit.forPerson'))}</p>
</div>`
    : ''

  return `${sessionPanel}\n${devicePanel}\n${signInPanel}`
}
