import { ImportFileError } from './errors.js'

export const FIXED_COLUMNS = ['email', 'first_name', 'last_name', 'phone', 'language'] as const
export type FixedColumn = (typeof FIXED_COLUMNS)[number]

export interface ClaimTypeInfo {
  key: string
  multiValued: boolean
  valuePattern: string | null
}

const ALIASES: Record<string, FixedColumn> = {
  e_mail: 'email',
  mail: 'email',
  firstname: 'first_name',
  given_name: 'first_name',
  lastname: 'last_name',
  surname: 'last_name',
  family_name: 'last_name',
}

/** "E-Mail", " First Name " and "first_name" are the same column. */
export const normalizeColumn = (name: string) => {
  const key = name.trim().toLowerCase().replace(/[\s-]+/g, '_')
  return ALIASES[key] ?? key
}

const distance = (a: string, b: string) => {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = above
    }
  }
  return row[b.length]!
}

/** The known claim type closest to a mistyped column, if any is close enough to be a likely typo. */
export const suggestClaimType = (column: string, known: string[]) => {
  const wanted = normalizeColumn(column)
  const best = known
    .map((key) => ({ key, distance: distance(wanted, key) }))
    .sort((a, b) => a.distance - b.distance)[0]
  return best && best.distance <= Math.max(2, Math.floor(wanted.length / 4)) ? best.key : undefined
}

export interface Columns {
  /** For each position in the header: the fixed column, the claim type, or undefined if ignored. */
  byIndex: ({ kind: 'fixed'; name: FixedColumn } | { kind: 'claim'; key: string } | undefined)[]
  claimColumns: string[]
  /** Which of the optional fixed columns the file has; those it lacks are left untouched on update. */
  has: Record<FixedColumn, boolean>
  warnings: string[]
}

/**
 * Decides what each column of the header is. Unknown columns abort the import, naming the column and
 * the closest claim type, because a typo would otherwise silently drop or reject the whole column.
 */
export const classifyColumns = (
  header: string[],
  claimTypes: ClaimTypeInfo[],
  { ignoreUnknown = false, dataInColumn }: { ignoreUnknown?: boolean; dataInColumn?: (index: number) => boolean } = {},
): Columns => {
  const known = claimTypes.map((claimType) => claimType.key)
  const has = Object.fromEntries(FIXED_COLUMNS.map((name) => [name, false])) as Record<FixedColumn, boolean>
  const seen = new Map<string, string>()
  const warnings: string[] = []
  const unknown: string[] = []
  const claimColumns: string[] = []

  const byIndex = header.map((original, index) => {
    if (original === '') {
      if (dataInColumn?.(index)) {
        throw new ImportFileError(`Column ${index + 1} has no name but contains data. Name it, or delete it.`)
      }
      return undefined
    }
    const name = normalizeColumn(original)
    const earlier = seen.get(name)
    if (earlier !== undefined) {
      throw new ImportFileError(`The column "${original}" appears twice (also as "${earlier}").`)
    }
    seen.set(name, original)

    if ((FIXED_COLUMNS as readonly string[]).includes(name)) {
      has[name as FixedColumn] = true
      return { kind: 'fixed' as const, name: name as FixedColumn }
    }
    if (known.includes(name)) {
      claimColumns.push(name)
      return { kind: 'claim' as const, key: name }
    }
    unknown.push(original)
    if (ignoreUnknown) warnings.push(`The column "${original}" is not a claim type and was ignored.`)
    return undefined
  })

  const missing = (['email', 'first_name', 'last_name'] as const).filter((name) => !has[name])
  if (missing.length > 0) {
    throw new ImportFileError(`The header needs the columns ${missing.join(', ')}. It has: ${header.join(', ')}.`)
  }

  if (unknown.length > 0 && !ignoreUnknown) {
    const lines = unknown.map((column) => {
      const suggestion = suggestClaimType(column, known)
      return `"${column}"${suggestion ? ` (did you mean "${suggestion}"?)` : ''}`
    })
    throw new ImportFileError(
      `These columns are neither a standard column nor a claim type: ${lines.join(', ')}. ` +
        `Claim types: ${known.length ? known.join(', ') : 'none yet'}. Fix the header, create the claim type, or skip them with --ignore-unknown-columns.`,
    )
  }

  return { byIndex, claimColumns, has, warnings }
}
