import type { Changes, ImportReport, RowResult } from '@progwise/pforte-import'

const number = new Intl.NumberFormat('en-US')
const LIMIT = 10

const describeChanges = ({ profile, claims }: Changes) =>
  [
    ...Object.entries(profile).map(([field, { from, to }]) => `${field}: ${from === null ? '(none)' : String(from)} → ${to === null ? '(none)' : String(to)}`),
    ...Object.entries(claims).map(([type, { from, to }]) => `${type}: [${from.join(', ')}] → [${to.join(', ')}]`),
  ].join('; ')

const more = (shown: number, total: number) => (total > shown ? [`  … and ${number.format(total - shown)} more (see --report)`] : [])

const listRows = (rows: RowResult[], describe: (row: RowResult) => string) => [
  ...rows.slice(0, LIMIT).map((row) => `  line ${row.line}: ${row.email || '(no e-mail)'}${describe(row) ? ` — ${describe(row)}` : ''}`),
  ...more(Math.min(rows.length, LIMIT), rows.length),
]

/** The text printed at the end of an import. */
export const formatSummary = (report: ImportReport, { rejectedFile }: { rejectedFile?: string } = {}) => {
  const { counts, missing } = report
  const lines: string[] = []
  lines.push(report.dryRun ? 'DRY RUN: nothing was written. This is what would happen.' : `Import finished in ${(report.durationMs / 1000).toFixed(1)} s.`)
  lines.push(`File: ${number.format(report.totalRows)} rows, separated by "${report.delimiter}".`)
  lines.push('')
  const verb = report.dryRun ? { created: 'would be created', updated: 'would be updated', unchanged: 'unchanged' } : { created: 'created', updated: 'updated', unchanged: 'unchanged' }
  lines.push(`  ${number.format(counts.created).padStart(7)}  ${verb.created}`)
  lines.push(`  ${number.format(counts.updated).padStart(7)}  ${verb.updated}`)
  lines.push(`  ${number.format(counts.unchanged).padStart(7)}  ${verb.unchanged}${report.totalRows > 0 && counts.unchanged === report.totalRows ? ' (the file changes nothing)' : ''}`)
  lines.push(`  ${number.format(counts.rejected).padStart(7)}  rejected${counts.rejected > 0 && rejectedFile ? ` (written to ${rejectedFile})` : ''}`)
  lines.push(`  ${number.format(counts.failed).padStart(7)}  failed (the API could not be reached; run the import again)`)

  if (missing.mode !== 'ignore') {
    const action = missing.mode === 'lock' ? 'locked' : 'deleted'
    const done = missing.mode === 'lock' ? missing.locked : missing.deleted
    lines.push('')
    lines.push(`Users who are not in the file (--missing=${missing.mode}): ${number.format(done.length)} ${report.dryRun ? `would be ${action}` : action}${missing.skipped.length ? `, ${number.format(missing.skipped.length)} left alone` : ''}${missing.failed.length ? `, ${number.format(missing.failed.length)} failed` : ''}.`)
    lines.push(...done.slice(0, LIMIT).map((email) => `  ${email}`), ...more(Math.min(done.length, LIMIT), done.length))
  }

  const rejected = report.rows.filter((row) => row.outcome === 'rejected')
  if (rejected.length > 0) {
    lines.push('', 'Rejected rows:', ...listRows(rejected, (row) => row.reasons?.join(' ') ?? ''))
  }
  const failed = report.rows.filter((row) => row.outcome === 'failed')
  if (failed.length > 0) {
    lines.push('', 'Failed rows:', ...listRows(failed, (row) => row.reasons?.join(' ') ?? ''))
  }
  if (report.dryRun) {
    const changing = report.rows.filter((row) => (row.outcome === 'created' || row.outcome === 'updated') && row.changes)
    if (changing.length > 0) {
      lines.push('', 'Changes:', ...listRows(changing, (row) => row.outcome === 'created' ? 'new user' : `updated; ${describeChanges(row.changes!)}`))
    }
  }
  if (report.warnings.length > 0) lines.push('', ...report.warnings.map((warning) => `Warning: ${warning}`))
  return lines.join('\n')
}

export { rejectedCsv } from '@progwise/pforte-import'
