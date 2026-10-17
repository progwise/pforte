import { type AdminApi, ApiError, type Changes, type UpsertBody } from './api.js'
import { classifyColumns } from './columns.js'
import { ImportFileError } from './errors.js'
import { type MissingMode, planMissing } from './missing.js'
import { type Encoding, readCsv } from './read.js'
import { type ImportRow, type RejectedRow, validateRows } from './rows.js'

export interface ImportOptions {
  /** Check everything and report, but write nothing. */
  dryRun: boolean
  encoding?: Encoding
  valueSeparator?: string
  ignoreUnknownColumns?: boolean
  /** What to do with users who are not in the file. Default `ignore`. */
  missing?: MissingMode
  allowDelete?: boolean
  /** Default 20. */
  maxMissingPercent?: number
  force?: boolean
  /** Requests in flight at the same time. Default 8. */
  concurrency?: number
  onProgress?: (progress: { phase: 'users' | 'missing'; done: number; total: number }) => void
}

export interface RowResult {
  line: number
  email: string
  outcome: 'created' | 'updated' | 'unchanged' | 'rejected' | 'failed'
  changes?: Changes
  reasons?: string[]
}

export interface ImportReport {
  dryRun: boolean
  delimiter: ',' | ';'
  /** Rows in the file, not counting the header and empty rows. */
  totalRows: number
  counts: Record<'created' | 'updated' | 'unchanged' | 'rejected' | 'failed', number>
  warnings: string[]
  /** Every row except the unchanged ones, which are only counted. */
  rows: RowResult[]
  /** Rows that were not imported, with the cells of the file, to write back out as a CSV. */
  rejectedRows: RejectedRow[]
  /** With `dryRun`, "locked" and "deleted" are who would be. */
  missing: {
    mode: MissingMode
    locked: string[]
    deleted: string[]
    skipped: { email: string; reason: string }[]
    failed: { email: string; reason: string }[]
  }
  durationMs: number
}

/** Runs the tasks with at most `concurrency` at a time; stops taking new ones when one throws. */
const mapPool = async <T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>, onDone: () => void) => {
  const results = Array.from<R>({ length: items.length })
  let next = 0
  let stopped = false
  const worker = async () => {
    while (!stopped && next < items.length) {
      const index = next++
      try {
        results[index] = await task(items[index]!)
      } catch (error) {
        stopped = true
        throw error
      }
      onDone()
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, worker))
  return results
}

const bodyOf = (row: ImportRow): UpsertBody => ({
  firstName: row.firstName,
  lastName: row.lastName,
  ...(row.phone !== undefined && { phone: row.phone }),
  ...(row.language !== undefined && { language: row.language }),
  ...(Object.keys(row.claims).length > 0 && { claims: row.claims }),
})

const reasonsOf = (error: ApiError) =>
  error.problems.length > 0 ? error.problems.map((problem) => (problem.path ? `${problem.path}: ${problem.message}` : problem.message)) : [error.message]

/**
 * Imports a CSV file through the admin API. Everything that can be checked is checked first, and a
 * plan for users who are not in the file is made (and may refuse) before the first write. Bad rows are
 * rejected with their line and a reason while the good ones go through; a row that fails because the
 * API is unreachable is `failed`, which is different from rejected.
 */
export const runImport = async (bytes: Uint8Array, api: AdminApi, options: ImportOptions): Promise<ImportReport> => {
  const started = Date.now()
  const { dryRun, concurrency = 8, missing = 'ignore', onProgress } = options

  const file = readCsv(bytes, { encoding: options.encoding })
  const claimTypes = await api.claimTypes()
  const columns = classifyColumns(file.header, claimTypes, {
    ignoreUnknown: options.ignoreUnknownColumns,
    dataInColumn: (index) => file.rows.some((row) => (row.fields[index] ?? '').trim() !== ''),
  })
  const { valid, rejected, presentEmails } = validateRows(file, columns, claimTypes, { valueSeparator: options.valueSeparator })

  // Decide about missing users first: a refusal must come before the first write.
  const plan =
    missing === 'ignore'
      ? { toLock: [], toDelete: [], skipped: [] }
      : planMissing(await api.listUsers(), presentEmails, valid.length, {
          mode: missing,
          allowDelete: options.allowDelete ?? false,
          maxMissingPercent: options.maxMissingPercent ?? 20,
          force: options.force ?? false,
        })

  const fieldsByLine = new Map(file.rows.map((row) => [row.line, row.fields]))
  const rejectedRows: RejectedRow[] = [...rejected]
  const results: RowResult[] = rejected.map((row) => ({
    line: row.line,
    email: (row.fields[columns.byIndex.findIndex((column) => column?.kind === 'fixed' && column.name === 'email')] ?? '').trim().toLowerCase(),
    outcome: 'rejected' as const,
    reasons: row.reasons,
  }))

  let done = 0
  const outcomes = await mapPool(
    valid,
    concurrency,
    async (row): Promise<RowResult> => {
      try {
        const { outcome, changes } = await api.upsertUser(row.email, bodyOf(row), { dryRun })
        return { line: row.line, email: row.email, outcome, ...(outcome !== 'unchanged' && changes && { changes }) }
      } catch (error) {
        if (!(error instanceof ApiError)) {
          return { line: row.line, email: row.email, outcome: 'failed', reasons: [(error as Error).message] }
        }
        if (error.status === 401 || error.status === 403) {
          throw new ImportFileError(`The API refused the import (HTTP ${error.status}): ${error.message} Check that the client has the "directory" scope.`)
        }
        // The server's own rules said no to a row that passed ours.
        if (error.status === 400) {
          const reasons = reasonsOf(error)
          rejectedRows.push({ line: row.line, reasons, fields: fieldsByLine.get(row.line) ?? [] })
          return { line: row.line, email: row.email, outcome: 'rejected', reasons }
        }
        return { line: row.line, email: row.email, outcome: 'failed', reasons: [error.message] }
      }
    },
    () => onProgress?.({ phase: 'users', done: ++done, total: valid.length }),
  )
  results.push(...outcomes)

  const result = {
    mode: missing,
    locked: [] as string[],
    deleted: [] as string[],
    skipped: plan.skipped.map(({ user, reason }) => ({ email: user.email, reason })),
    failed: [] as { email: string; reason: string }[],
  }
  const targets = [
    ...plan.toLock.map((user) => ({ user, action: 'lock' as const })),
    ...plan.toDelete.map((user) => ({ user, action: 'delete' as const })),
  ]
  let missingDone = 0
  await mapPool(
    targets,
    concurrency,
    async ({ user, action }) => {
      try {
        const outcome = dryRun ? (action === 'lock' ? 'locked' : 'deleted') : action === 'lock' ? await api.lockUser(user.id) : await api.deleteUser(user.id)
        if (outcome === 'skipped') result.skipped.push({ email: user.email, reason: 'changed in the meantime' })
        else (action === 'lock' ? result.locked : result.deleted).push(user.email)
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          throw new ImportFileError(`The API refused to ${action} users (HTTP ${error.status}): ${error.message}`)
        }
        result.failed.push({ email: user.email, reason: (error as Error).message })
      }
    },
    () => onProgress?.({ phase: 'missing', done: ++missingDone, total: targets.length }),
  )

  const counts = { created: 0, updated: 0, unchanged: 0, rejected: 0, failed: 0 }
  for (const row of results) counts[row.outcome]++

  return {
    dryRun,
    delimiter: file.delimiter,
    totalRows: file.rows.length,
    counts,
    warnings: columns.warnings,
    rows: results.filter((row) => row.outcome !== 'unchanged').sort((a, b) => a.line - b.line),
    rejectedRows: rejectedRows.sort((a, b) => a.line - b.line),
    missing: { ...result, locked: result.locked.sort(), deleted: result.deleted.sort() },
    durationMs: Date.now() - started,
  }
}
