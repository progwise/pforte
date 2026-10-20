import { parse } from 'csv-parse/sync'
import { ImportFileError } from './errors.js'

export type Encoding = 'utf-8' | 'windows-1252'

export interface RawRow {
  /** The line of the file where the row starts (the first line is the header). */
  line: number
  fields: string[]
}

export interface ReadFile {
  /** Column names as written, trimmed. */
  header: string[]
  rows: RawRow[]
  delimiter: ',' | ';'
}

const UTF8_BOM = '﻿'

const decode = (bytes: Uint8Array, encoding: Encoding) => {
  try {
    return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new ImportFileError(
      encoding === 'utf-8'
        ? 'The file is not valid UTF-8, so names with umlauts would be garbled. In Excel choose "Save as" → "CSV UTF-8 (comma delimited)". ' +
            'If the file really is in Windows-1252 (the default of Excel in Germany), read it with --encoding windows-1252.'
        : `The file cannot be read as ${encoding}.`,
    )
  }
}

/** Counts the separator characters of the first line, outside quotes, and picks the more frequent one. */
const detectDelimiter = (text: string): ',' | ';' => {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  let commas = 0
  let semicolons = 0
  let quoted = false
  for (const char of firstLine) {
    if (char === '"') quoted = !quoted
    else if (!quoted && char === ',') commas++
    else if (!quoted && char === ';') semicolons++
  }
  return semicolons > commas ? ';' : ','
}

/** Line breaks of any kind. For a file with Windows line ends the parser's `raw` keeps only the `\r` of each `\r\n`. */
const newlinesIn = (text: string) => text.match(/\r\n|\r|\n/g)?.length ?? 0

/**
 * Reads a CSV file: UTF-8 (with or without BOM) or, on request, Windows-1252, separated by commas or
 * semicolons. Returns the header and the rows with the line each one starts on. Blank lines and
 * rows with only empty cells are skipped.
 */
export const readCsv = (bytes: Uint8Array, { encoding = 'utf-8' }: { encoding?: Encoding } = {}): ReadFile => {
  let text = decode(bytes, encoding)
  if (text.startsWith(UTF8_BOM)) text = text.slice(1)
  if (text.trim() === '') throw new ImportFileError('The file is empty.')

  const delimiter = detectDelimiter(text)
  let records: { record: string[]; raw: string }[]
  try {
    records = parse(text, {
      delimiter,
      info: true,
      raw: true,
      relax_column_count: true,
      skip_empty_lines: true,
      relax_quotes: false,
    }) as unknown as typeof records
  } catch (error) {
    const { lines, message } = error as { lines?: number; message: string }
    throw new ImportFileError(`The file is not valid CSV${lines ? ` (around line ${lines})` : ''}: ${message}`)
  }

  if (records.length === 0) throw new ImportFileError('The file has no header row.')

  // The raw text of the records is, in order, the whole file (skipped blank lines show up as leading
  // line breaks of the next record). Counting its line breaks gives every row's line exactly, also
  // after quoted line breaks, which the parser's own line counter gets wrong.
  let consumed = 0
  const located = records.map((entry) => {
    const leading = newlinesIn(/^(?:\r\n|\r|\n)*/.exec(entry.raw)?.[0] ?? '')
    const line = 1 + consumed + leading
    consumed += newlinesIn(entry.raw)
    return { line, fields: entry.record }
  })

  const [headerRecord, ...dataRows] = located
  // A row of nothing but empty cells (Excel leaves these at the end) is not a user.
  const rows = dataRows.filter((row) => row.fields.some((field) => field.trim() !== ''))

  return { header: headerRecord!.fields.map((name) => name.trim()), rows, delimiter }
}
