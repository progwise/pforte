import { parseArgs } from 'node:util'

export const HELP = `pforte: command line tools for pforte administrators

Usage:
  pforte import <file.csv> [options]

Import users and claims from a CSV file through the admin API.

  --dry-run                    Check everything and report, but write nothing
  --missing <ignore|lock|delete>
                               What to do with users who are not in the file
                               (default ignore). Administrators are never touched
  --allow-delete               Needed for --missing=delete, which cannot be undone
  --max-missing-percent <n>    Refuse if more than n% of the users would be affected
                               by --missing (default 20)
  --force                      Go ahead although that limit is exceeded
  --ignore-unknown-columns     Skip columns that are not claim types, with a warning
                               (by default they stop the import)
  --encoding <utf-8|windows-1252>
                               Encoding of the file (default utf-8)
  --value-separator <char>     Separates several claim values in one cell (default ;)
  --concurrency <n>            Requests at the same time (default 8)
  --report <file.json>         Write a full report as JSON
  --rejected <file.csv>        Write the rows that were not imported, with line and reason
  -h, --help                   Show this help

Settings from the environment:
  PFORTE_URL                   Where pforte runs, e.g. https://id.example.com
  PFORTE_CLIENT_ID             An admin client with the "directory" scope
  PFORTE_CLIENT_SECRET         Its secret (or PFORTE_CLIENT_SECRET_FILE: a file holding it)

Exit codes: 0 everything imported, 2 some rows were rejected or failed, 1 the import could not run.
`

export class UsageError extends Error {}

export interface ImportCommand {
  command: 'import'
  file: string
  dryRun: boolean
  missing: 'ignore' | 'lock' | 'delete'
  allowDelete: boolean
  maxMissingPercent: number
  force: boolean
  ignoreUnknownColumns: boolean
  encoding: 'utf-8' | 'windows-1252'
  valueSeparator: string
  concurrency: number
  report?: string
  rejected?: string
}

const oneOf = <T extends string>(name: string, value: string, allowed: readonly T[]): T => {
  if (!(allowed as readonly string[]).includes(value)) throw new UsageError(`${name} must be one of: ${allowed.join(', ')}.`)
  return value as T
}

const number = (name: string, value: string, { min, max }: { min: number; max?: number }) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < min || (max !== undefined && parsed > max)) {
    throw new UsageError(`${name} must be a number from ${min}${max !== undefined ? ` to ${max}` : ' up'}.`)
  }
  return parsed
}

/** Turns the command line into a command, or throws a `UsageError` that says what is wrong. `null` means "show the help". */
export const parseCommand = (argv: string[]): ImportCommand | null => {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'dry-run': { type: 'boolean' },
        missing: { type: 'string' },
        'allow-delete': { type: 'boolean' },
        'max-missing-percent': { type: 'string' },
        force: { type: 'boolean' },
        'ignore-unknown-columns': { type: 'boolean' },
        encoding: { type: 'string' },
        'value-separator': { type: 'string' },
        concurrency: { type: 'string' },
        report: { type: 'string' },
        rejected: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (error) {
    throw new UsageError(`${(error as Error).message.replace(/ to treat it as a positional.*$/, '')} Try: pforte --help`)
  }

  const { values, positionals } = parsed
  if (values.help || positionals.length === 0) return null

  const [command, file, ...extra] = positionals
  if (command !== 'import') throw new UsageError(`Unknown command "${command}". The only command is import. Try: pforte --help`)
  if (!file) throw new UsageError('Which file? Usage: pforte import <file.csv> [options]')
  if (extra.length > 0) throw new UsageError(`Unexpected extra arguments: ${extra.join(' ')}. Quote file names with spaces.`)

  const separator = values['value-separator'] ?? ';'
  if ([...separator].length !== 1) throw new UsageError('--value-separator must be a single character.')

  return {
    command,
    file,
    dryRun: values['dry-run'] ?? false,
    missing: oneOf('--missing', values.missing ?? 'ignore', ['ignore', 'lock', 'delete']),
    allowDelete: values['allow-delete'] ?? false,
    maxMissingPercent: number('--max-missing-percent', values['max-missing-percent'] ?? '20', { min: 0, max: 100 }),
    force: values.force ?? false,
    ignoreUnknownColumns: values['ignore-unknown-columns'] ?? false,
    encoding: oneOf('--encoding', values.encoding ?? 'utf-8', ['utf-8', 'windows-1252']),
    valueSeparator: separator,
    concurrency: number('--concurrency', values.concurrency ?? '8', { min: 1, max: 64 }),
    report: values.report,
    rejected: values.rejected,
  }
}
