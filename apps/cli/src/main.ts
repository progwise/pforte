import { type AdminApi, createHttpAdminApi, ImportFileError, runImport } from '@progwise/pforte-import'
import { formatSummary, rejectedCsv } from './format.js'
import { HELP, parseCommand, UsageError } from './options.js'

export interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** Whether stderr is a terminal, where progress can be redrawn in place. */
  interactive: boolean
  readFile: (path: string) => Promise<Uint8Array>
  /** Files with personal data are written readable by the owner only. */
  writeFile: (path: string, content: string) => Promise<void>
  createApi?: (settings: { baseUrl: string; clientId: string; clientSecret: string }) => AdminApi
}

const setting = (env: Record<string, string | undefined>, name: string) => env[name]?.trim() || undefined

/** The admin client's credentials from the environment; the secret may also come from a file. */
const credentials = async (env: Record<string, string | undefined>, io: CliIo) => {
  const baseUrl = setting(env, 'PFORTE_URL')
  const clientId = setting(env, 'PFORTE_CLIENT_ID')
  const secretFile = setting(env, 'PFORTE_CLIENT_SECRET_FILE')
  if (setting(env, 'PFORTE_CLIENT_SECRET') && secretFile) {
    throw new UsageError('Set either PFORTE_CLIENT_SECRET or PFORTE_CLIENT_SECRET_FILE, not both.')
  }
  const clientSecret = secretFile ? new TextDecoder().decode(await io.readFile(secretFile)).trim() : setting(env, 'PFORTE_CLIENT_SECRET')

  const missing = [!baseUrl && 'PFORTE_URL', !clientId && 'PFORTE_CLIENT_ID', !clientSecret && 'PFORTE_CLIENT_SECRET (or PFORTE_CLIENT_SECRET_FILE)'].filter(Boolean)
  if (missing.length > 0 || !baseUrl || !clientId || !clientSecret) {
    throw new UsageError(`Missing settings: ${missing.join(', ')}. They tell the import where pforte runs and which admin client to use. See: pforte --help`)
  }
  return { baseUrl, clientId, clientSecret }
}

/** Runs the command line and returns the exit code: 0 clean, 2 some rows rejected or failed, 1 could not run. */
export const runCli = async (argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> => {
  try {
    const command = parseCommand(argv)
    if (!command) {
      io.stdout(HELP)
      return argv.includes('--help') || argv.includes('-h') ? 0 : 1
    }

    let bytes: Uint8Array
    try {
      bytes = await io.readFile(command.file)
    } catch (error) {
      throw new ImportFileError(`Cannot read ${command.file}: ${(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'there is no such file' : (error as Error).message}.`)
    }

    const settings = await credentials(env, io)
    const api = (io.createApi ?? createHttpAdminApi)(settings)

    let lastShown = -1
    const report = await runImport(bytes, api, {
      dryRun: command.dryRun,
      encoding: command.encoding,
      valueSeparator: command.valueSeparator,
      ignoreUnknownColumns: command.ignoreUnknownColumns,
      missing: command.missing,
      allowDelete: command.allowDelete,
      maxMissingPercent: command.maxMissingPercent,
      force: command.force,
      concurrency: command.concurrency,
      onProgress: ({ phase, done, total }) => {
        const label = phase === 'users' ? 'Users' : 'Users not in the file'
        if (io.interactive) io.stderr(`\r${label}: ${done}/${total}`)
        else {
          // Without a terminal, one line per quarter keeps logs short.
          const quarter = Math.floor((done / total) * 4)
          if (done === total || quarter !== lastShown) io.stderr(`${label}: ${done}/${total}\n`)
          lastShown = quarter
        }
      },
    })
    if (io.interactive) io.stderr('\r\u001B[K')

    if (command.rejected && report.rejectedRows.length > 0) await io.writeFile(command.rejected, rejectedCsv(report))
    if (command.report) await io.writeFile(command.report, `${JSON.stringify(report, null, 2)}\n`)

    io.stdout(formatSummary(report, { rejectedFile: command.rejected }))
    const problems = report.counts.rejected + report.counts.failed + report.missing.failed.length
    return problems > 0 ? 2 : 0
  } catch (error) {
    if (error instanceof UsageError || error instanceof ImportFileError) {
      io.stderr(`${io.interactive ? '\r\u001B[K' : ''}${error.message}\n`)
      return 1
    }
    throw error
  }
}
