import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { parseAcceptLanguage } from '../i18n/index.js'
import type { MessageKey, Values } from '../i18n/index.js'
import { readCookie, setCookieHeader, unsign } from '../interaction/signed-cookie.js'
import type { Ui } from '../ui/index.js'
import { createApiCaller, type ApiCall } from './api.js'
import { MANAGE_PATH } from './constants.js'
import { type Flash, setFlash, takeFlash } from './flash.js'

export interface ManageDependencies {
  /** The public address of pforte. */
  issuer: string
  /** Sign the cookies of the UI. */
  cookieKeys: string[]
  ui: Ui
  /** Named on the start page. */
  organisation: string
  /** Where times are shown: an IANA time zone such as `Europe/Berlin`. */
  timeZone: string
}

/** The session of a person in the UI: kept in a signed cookie, so there is nothing to store on the server. */
export interface ManageSession {
  token: string
  /** Kept to tell pforte who is signing out. */
  idToken: string
  user: { id: string; name: string; language: string }
  expiresAt: number
}

export const SESSION_COOKIE = 'pforte_manage'

/** What the sections of the administration need: the session, the pages, the API, and messages between pages. */
export const createManageContext = (app: FastifyInstance, { issuer, cookieKeys, ui, organisation, timeZone }: ManageDependencies) => {
  const secure = issuer.startsWith('https:')
  const callApi = createApiCaller(app)

  const acceptedLanguages = (request: FastifyRequest) => parseAcceptLanguage(request.headers['accept-language'])
  const languageOf = (request: FastifyRequest, session?: ManageSession) => ui.i18n.pick(session?.user.language, acceptedLanguages(request))

  const viewFor = (request: FastifyRequest, session?: ManageSession) => {
    const view = ui.pages.for(languageOf(request, session))
    return { view, language: view.language, t: (key: MessageKey, values?: Values) => view.t(key, values) }
  }

  const cookie = (name: string, value: string, maxAgeSeconds: number) => setCookieHeader(name, value, { path: MANAGE_PATH, maxAgeSeconds, secure })

  const sessionOf = (request: FastifyRequest) => {
    const session = unsign<ManageSession>(cookieKeys, readCookie(request.headers.cookie, SESSION_COOKIE))
    return session && session.expiresAt > Date.now() ? session : undefined
  }

  /** The session, or the person is sent to sign in and brought back to where they were going. */
  const requireSession = (request: FastifyRequest, reply: FastifyReply) => {
    const session = sessionOf(request)
    if (!session) {
      const next = request.method === 'GET' ? `?next=${encodeURIComponent(request.url)}` : ''
      void reply.redirect(`${MANAGE_PATH}/login${next}`, 303)
    }
    return session
  }

  /** The API said the token is no good any more (the person was locked, or lost the admin right): sign in again. */
  const sessionEnded = (reply: FastifyReply) => {
    reply.header('Set-Cookie', cookie(SESSION_COOKIE, '', 0))
    return reply.redirect(`${MANAGE_PATH}/login`, 303)
  }

  /** The sections the person can open. */
  const sections = (t: (key: MessageKey) => string, current: string) => [
    { href: MANAGE_PATH, label: t('manage.nav.home'), current: current === 'home' },
    { href: `${MANAGE_PATH}/users`, label: t('manage.nav.users'), current: current === 'users' },
  ]

  /** A page of the administration for a person who is signed in, with the message the last action left. */
  const page = (request: FastifyRequest, reply: FastifyReply, session: ManageSession, current: string, title: string, content: string) => {
    const { view, t } = viewFor(request, session)
    const flash = takeFlash(request, reply, cookieKeys, secure)
    return view.manage({
      title,
      sectionsLabel: t('manage.nav.label'),
      nav: sections(t, current),
      person: { signedInAs: t('manage.signedInAs', { name: session.user.name }), signOutLabel: t('manage.signOut') },
      flash: flash && { kind: flash.kind, text: flash.text ?? (flash.key ? t(flash.key, flash.values) : '') },
      content,
    })
  }

  /** Leave a message for the next page and go there. */
  const redirectWith = (reply: FastifyReply, to: string, flash: Flash) => {
    setFlash(reply, cookieKeys, secure, flash)
    return reply.redirect(to, 303)
  }

  /** What the API said was wrong, in a sentence: its own words, with the fields it names. */
  const problemText = (body: unknown) => {
    const problem = body as { detail?: string; title?: string; errors?: { path: string; message: string }[] } | undefined
    const fields = problem?.errors?.map((error) => `${error.path.replace(/^\//, '').replaceAll('/', ' ') || 'request'}: ${error.message}`)
    return fields?.length ? fields.join('; ') : (problem?.detail ?? problem?.title ?? 'The request was refused.')
  }

  /** The field errors of an API answer, by the name of the field: `{ email: 'Invalid e-mail address' }`. */
  const fieldErrors = (body: unknown) => {
    const errors = (body as { errors?: { path: string; message: string }[] } | undefined)?.errors ?? []
    return Object.fromEntries(errors.map((error) => [error.path.replace(/^\//, '').split('/')[0] ?? '', error.message]))
  }

  const formatTime = (iso: string | null | undefined, language: string) => {
    if (!iso) return ''
    try {
      return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(iso))
    } catch {
      return iso
    }
  }

  return {
    issuer,
    cookieKeys,
    ui,
    organisation,
    secure,
    acceptedLanguages,
    languageOf,
    viewFor,
    cookie,
    sessionOf,
    requireSession,
    sessionEnded,
    page,
    redirectWith,
    problemText,
    fieldErrors,
    formatTime,
    /** Calls the admin API as the person who is signed in. */
    api: (request: FastifyRequest, session: ManageSession, call: ApiCall) => callApi(request, session.token, call),
    callApi,
  }
}

export type ManageContext = ReturnType<typeof createManageContext>
