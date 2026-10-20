import multipart from '@fastify/multipart'
import { ApiError, ImportFileError, type ImportReport, type Changes, rejectedCsv, runImport } from '@progwise/pforte-import'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { escapeHtml } from '../ui/pages.js'
import { text, withAlert } from './common.js'
import { MANAGE_PATH } from './constants.js'
import type { ManageContext, ManageSession } from './context.js'
import { badge, checkbox, field, fileInput, link, select } from './html.js'
import { createInProcessAdminApi } from './import-api.js'
import { createImportStore, type ImportSettings, type ImportStore } from './import-store.js'

const BASE = `${MANAGE_PATH}/import`
const SECTION = 'import'
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024
/** Rows shown on the page: the rest is in the download. */
const SHOWN_ROWS = 50
const SHOWN_NAMES = 10

const describeChanges = ({ profile, claims }: Changes) =>
  [
    ...Object.entries(profile).map(([name, { from, to }]) => `${name}: ${from === null ? '–' : String(from)} → ${to === null ? '–' : String(to)}`),
    ...Object.entries(claims).map(([type, { from, to }]) => `${type}: [${from.join(', ')}] → [${to.join(', ')}]`),
  ].join('; ')

/** What a person typed into the form, kept so that a refused form comes back as it was filled in. */
interface ImportForm {
  encoding: ImportSettings['encoding']
  valueSeparator: string
  ignoreUnknown: boolean
  missing: ImportSettings['missing']
  maxMissingPercent: string
  confirmDelete: string
}

const defaultForm = (): ImportForm => ({ encoding: 'utf-8', valueSeparator: ';', ignoreUnknown: false, missing: 'ignore', maxMissingPercent: '20', confirmDelete: '' })

/** Imports users from a CSV file: checked first, written only when the person confirms. */
export const registerImport = (app: FastifyInstance, ctx: ManageContext, store: ImportStore = createImportStore()) => {
  const { requireSession, api, page, viewFor, problemText, formatTime, sessionEnded } = ctx

  const interval = setInterval(store.sweep, 60_000)
  interval.unref()
  app.addHook('onClose', async () => {
    clearInterval(interval)
    store.clear()
  })

  // @fastify/multipart is only for this page: the other pages take no uploads.
  void app.register(async (scope) => {
    await scope.register(multipart, { throwFileSizeLimit: true, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, fieldSize: 1000, parts: 12 } })

    const formPage = (request: FastifyRequest, reply: FastifyReply, session: ManageSession, values: ImportForm, errors: Record<string, string> = {}, alert?: string, status = 200) => {
      const { t } = viewFor(request, session)
      const content = `<h1>${escapeHtml(t('manage.import.title'))}</h1>
<p class="muted">${escapeHtml(t('manage.import.intro'))}</p>
<div class="panel"><h2>${escapeHtml(t('manage.import.format.title'))}</h2><p>${escapeHtml(t('manage.import.format.text'))}</p></div>
<div class="panel"><form class="fields stack" method="post" enctype="multipart/form-data" action="${BASE}">
${fileInput({ id: 'file', label: t('manage.import.file'), accept: '.csv,text/csv', hint: t('manage.import.fileHint'), error: errors.file, required: true })}
${select({ id: 'encoding', label: t('manage.import.encoding'), value: values.encoding, choices: [{ value: 'utf-8', label: t('manage.import.encoding.utf8') }, { value: 'windows-1252', label: t('manage.import.encoding.windows') }] })}
${field({ id: 'valueSeparator', label: t('manage.import.valueSeparator'), value: values.valueSeparator, maxLength: 1, error: errors.valueSeparator, required: true })}
${checkbox({ id: 'ignoreUnknown', label: t('manage.import.ignoreUnknown'), checked: values.ignoreUnknown })}
${select({ id: 'missing', label: t('manage.import.missing'), value: values.missing, choices: (['ignore', 'lock', 'delete'] as const).map((mode) => ({ value: mode, label: t(`manage.import.missing.${mode}`) })) })}
<small class="muted">${escapeHtml(t('manage.import.missingHint'))}</small>
${field({ id: 'maxMissingPercent', type: 'number', label: t('manage.import.maxMissing'), value: values.maxMissingPercent, hint: t('manage.import.maxMissingHint'), error: errors.maxMissingPercent, required: true })}
${field({ id: 'confirmDelete', label: t('manage.import.confirmDelete', { word: t('manage.import.deleteWord') }), value: values.confirmDelete, hint: t('manage.import.confirmDeleteHint'), error: errors.confirmDelete })}
<div class="submit"><button type="submit">${escapeHtml(t('manage.import.check'))}</button></div>
</form></div>`
      const html = page(request, reply, session, SECTION, t('manage.import.title'), content)
      return reply.code(status).type('text/html').send(alert ? withAlert(html, alert) : html)
    }

    // --- The result of a check or an import

    const resultPage = (request: FastifyRequest, reply: FastifyReply, session: ManageSession, report: ImportReport, token: string) => {
      const { t, language } = viewFor(request, session)
      const n = new Intl.NumberFormat(language)
      const dry = report.dryRun
      const { counts, missing } = report

      const countRow = (kind: 'created' | 'updated' | 'unchanged' | 'rejected' | 'failed', label: string, tone?: string) =>
        `<dt>${tone ? badge(tone, n.format(counts[kind])) : escapeHtml(n.format(counts[kind]))}</dt><dd>${escapeHtml(label)}</dd>`
      const summary = `<dl class="facts counts">
${countRow('created', t(dry ? 'manage.import.createdDry' : 'manage.import.created'))}
${countRow('updated', t(dry ? 'manage.import.updatedDry' : 'manage.import.updated'))}
${countRow('unchanged', t('manage.import.unchanged'))}
${countRow('rejected', t('manage.import.rejected'), counts.rejected ? 'locked' : undefined)}
${countRow('failed', t('manage.import.failed'), counts.failed ? 'locked' : undefined)}
</dl>`

      const names = (list: string[]) =>
        `<p class="muted">${list.slice(0, SHOWN_NAMES).map(escapeHtml).join(', ')}${list.length > SHOWN_NAMES ? ` ${escapeHtml(t('manage.import.moreItems', { count: n.format(list.length - SHOWN_NAMES) }))}` : ''}</p>`
      const missingBlock =
        missing.mode === 'ignore'
          ? ''
          : `<h2>${escapeHtml(t('manage.import.missingTitle'))}</h2>
<div class="panel"><ul>
${missing.mode === 'lock' ? `<li>${escapeHtml(t(dry ? 'manage.import.lockedDry' : 'manage.import.locked', { count: n.format(missing.locked.length) }))}</li>` : ''}
${missing.mode === 'delete' ? `<li>${escapeHtml(t(dry ? 'manage.import.deletedDry' : 'manage.import.deleted', { count: n.format(missing.deleted.length) }))}</li>` : ''}
${missing.skipped.length ? `<li>${escapeHtml(t('manage.import.skipped', { count: n.format(missing.skipped.length) }))}</li>` : ''}
${missing.failed.length ? `<li>${escapeHtml(t('manage.import.missingFailed', { count: n.format(missing.failed.length) }))}</li>` : ''}
</ul>${names(missing.mode === 'lock' ? missing.locked : missing.deleted)}</div>`

      const rowTable = (rows: ImportReport['rows'], third: 'reason' | 'change') =>
        `<div class="scroll"><table class="list">
<thead><tr><th>${escapeHtml(t('manage.import.line'))}</th><th>${escapeHtml(t('manage.import.email'))}</th><th>${escapeHtml(t(third === 'reason' ? 'manage.import.reason' : 'manage.import.change'))}</th></tr></thead>
<tbody>
${rows
  .slice(0, SHOWN_ROWS)
  .map((row) => `<tr><td>${row.line}</td><td>${escapeHtml(row.email)}</td><td>${escapeHtml(third === 'reason' ? (row.reasons ?? []).join(' ') : row.outcome === 'created' ? t('manage.import.newPerson') : row.changes ? describeChanges(row.changes) : t('manage.import.noChange'))}</td></tr>`)
  .join('\n')}
</tbody></table></div>${rows.length > SHOWN_ROWS ? `<p class="muted">${escapeHtml(t('manage.import.moreRows', { count: n.format(rows.length - SHOWN_ROWS) }))}</p>` : ''}`

      const rejected = report.rows.filter((row) => row.outcome === 'rejected')
      const rejectedBlock = rejected.length
        ? `<h2>${escapeHtml(t('manage.import.rejectedTitle'))}</h2>
<div class="panel"><p>${escapeHtml(t('manage.import.rejectedHelp'))}</p>
${rowTable(rejected, 'reason')}
<p>${link(`${BASE}/rejected?${new URLSearchParams({ token })}`, t('manage.import.download'), 'button secondary')}</p></div>`
        : ''
      const failed = report.rows.filter((row) => row.outcome === 'failed')
      const failedBlock = failed.length ? `<h2>${escapeHtml(t('manage.import.failedTitle'))}</h2>\n<div class="panel">${rowTable(failed, 'reason')}</div>` : ''
      const changing = dry ? report.rows.filter((row) => (row.outcome === 'created' || row.outcome === 'updated') && (row.changes || row.outcome === 'created')) : []
      const changesBlock = changing.length ? `<h2>${escapeHtml(t('manage.import.changesTitle'))}</h2>\n<div class="panel">${rowTable(changing, 'change')}</div>` : ''
      const warningsBlock = report.warnings.length ? `<h2>${escapeHtml(t('manage.import.warningsTitle'))}</h2>\n<div class="panel"><ul>${report.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></div>` : ''

      const wouldChange = counts.created + counts.updated + missing.locked.length + missing.deleted.length > 0
      const next = dry
        ? wouldChange
          ? `<div class="panel"><p>${escapeHtml(t('manage.import.applyText'))}</p>
<form method="post" action="${BASE}/apply"><input type="hidden" name="token" value="${escapeHtml(token)}">
<div class="actions"><button type="submit">${escapeHtml(t('manage.import.apply'))}</button>${link(BASE, t('manage.import.choose'), 'button secondary')}</div></form></div>`
          : `<div class="panel"><p>${escapeHtml(t('manage.import.nothing'))}</p><p>${link(BASE, t('manage.import.choose'), 'button')}</p></div>`
        : `<div class="actions">${link(BASE, t('manage.import.another'), 'button')}</div>`

      const title = dry ? t('manage.import.dryTitle') : t('manage.import.doneTitle', { seconds: (report.durationMs / 1000).toFixed(1) })
      const content = `<h1>${escapeHtml(t('manage.import.title'))}</h1>
<div class="panel"><h2>${escapeHtml(title)}</h2>
<p>${escapeHtml(t('manage.import.rows', { rows: n.format(report.totalRows) }))}</p>
${summary}</div>
${missingBlock}
${rejectedBlock}
${failedBlock}
${changesBlock}
${warningsBlock}
${next}`
      return reply.type('text/html').header('Cache-Control', 'no-store').send(page(request, reply, session, SECTION, t('manage.import.title'), content))
    }

    scope.get(BASE, async (request, reply) => {
      const session = requireSession(request, reply)
      return session ? formPage(request, reply, session, defaultForm()) : reply
    })

    // --- Checking the file

    const readUpload = async (request: FastifyRequest) => {
      const fields: Record<string, string> = {}
      let file: Buffer | undefined
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          const bytes = await part.toBuffer()
          if (part.fieldname === 'file' && bytes.length > 0) file = bytes
        } else if (typeof part.value === 'string') fields[part.fieldname] = part.value
      }
      return { fields, file }
    }

    scope.post(BASE, async (request, reply) => {
      const session = requireSession(request, reply)
      if (!session) return reply
      const { t } = viewFor(request, session)
      if (!request.isMultipart()) return formPage(request, reply, session, defaultForm(), {}, t('manage.import.invalidOption'), 415)

      let upload: Awaited<ReturnType<typeof readUpload>>
      try {
        upload = await readUpload(request)
      } catch (error) {
        if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          return formPage(request, reply, session, defaultForm(), { file: t('manage.import.tooLarge') }, t('manage.import.invalidOption'), 413)
        }
        throw error
      }
      const { fields, file } = upload

      const values: ImportForm = {
        encoding: fields.encoding === 'windows-1252' ? 'windows-1252' : 'utf-8',
        valueSeparator: (fields.valueSeparator ?? ';').slice(0, 1),
        ignoreUnknown: fields.ignoreUnknown === 'on',
        missing: fields.missing === 'lock' || fields.missing === 'delete' ? fields.missing : 'ignore',
        maxMissingPercent: (fields.maxMissingPercent ?? '20').trim(),
        confirmDelete: (fields.confirmDelete ?? '').trim(),
      }
      const percent = Number(values.maxMissingPercent)
      const errors: Record<string, string> = {}
      if (!file) errors.file = t('manage.import.noFile')
      if (values.valueSeparator === '') errors.valueSeparator = t('manage.import.invalidOption')
      if (!Number.isFinite(percent) || percent < 0 || percent > 100 || values.maxMissingPercent === '') errors.maxMissingPercent = t('manage.import.invalidOption')
      const allowDelete = values.confirmDelete.toLowerCase() === t('manage.import.deleteWord').toLowerCase()
      if (values.missing === 'delete' && !allowDelete) errors.confirmDelete = t('manage.import.deleteNotConfirmed', { word: t('manage.import.deleteWord') })
      if (Object.keys(errors).length > 0) return formPage(request, reply, session, values, errors, t('manage.import.invalidOption'), 422)

      const settings: ImportSettings = {
        encoding: values.encoding,
        valueSeparator: values.valueSeparator,
        ignoreUnknownColumns: values.ignoreUnknown,
        missing: values.missing,
        allowDelete: values.missing === 'delete' && allowDelete,
        maxMissingPercent: percent,
      }
      return run(request, reply, session, { bytes: new Uint8Array(file!), settings, dryRun: true, form: values })
    })

    /** Runs the import, as a check or for real, and answers with its result. */
    const run = async (request: FastifyRequest, reply: FastifyReply, session: ManageSession, job: { bytes: Uint8Array; settings: ImportSettings; dryRun: boolean; token?: string; form?: ImportForm }) => {
      const { t } = viewFor(request, session)
      const adapter = createInProcessAdminApi((call) => api(request, session, call))
      const form = job.form ?? defaultForm()
      try {
        const report = await runImport(job.bytes, adapter, { ...job.settings, dryRun: job.dryRun, concurrency: 8 })
        if (adapter.sessionEnded()) return sessionEnded(reply)
        const csv = report.rejectedRows.length ? rejectedCsv(report) : undefined
        const token = job.dryRun ? store.put({ userId: session.user.id, bytes: job.bytes, settings: job.settings, rejectedCsv: csv }) : job.token!
        if (!job.dryRun) store.setRejectedCsv(token, csv)
        return resultPage(request, reply, session, report, token)
      } catch (error) {
        if (adapter.sessionEnded()) return sessionEnded(reply)
        if (error instanceof ImportFileError) return formPage(request, reply, session, form, {}, t('manage.import.cannot', { reason: error.message }), 422)
        if (error instanceof ApiError) return formPage(request, reply, session, form, {}, t('manage.import.cannot', { reason: problemText({ detail: error.message, errors: error.problems }) }), error.status >= 400 && error.status < 600 ? error.status : 502)
        throw error
      }
    }

    // --- Importing what was checked

    scope.post<{ Body: Record<string, unknown> }>(`${BASE}/apply`, async (request, reply) => {
      const session = requireSession(request, reply)
      if (!session) return reply
      const { t } = viewFor(request, session)
      const token = text(request.body, 'token')
      const entry = token ? store.get(token, session.user.id) : undefined
      const bytes = entry?.bytes
      if (!entry || !bytes) return formPage(request, reply, session, defaultForm(), {}, t('manage.import.expired'), 410)
      // Taken at once: a second click on "Import now" must not run the file twice.
      store.release(token)
      return run(request, reply, session, { bytes, settings: entry.settings, dryRun: false, token })
    })

    scope.get<{ Querystring: { token?: string } }>(`${BASE}/rejected`, async (request, reply) => {
      const session = requireSession(request, reply)
      if (!session) return reply
      const entry = request.query.token ? store.get(request.query.token, session.user.id) : undefined
      if (!entry?.rejectedCsv) return reply.code(404).type('text/plain').send('Not found')
      return reply
        .header('Content-Disposition', 'attachment; filename="rejected-rows.csv"')
        .header('Cache-Control', 'no-store')
        .type('text/csv; charset=utf-8')
        .send(entry.rejectedCsv)
    })
  })
}

