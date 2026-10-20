import type { ImportReport } from './run.js'

const escapeCell = (value: string, delimiter: string) => (value.includes(delimiter) || /["\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value)

/**
 * The rows that were not imported, in the layout of the original file plus the columns `line` and
 * `reason`, so they can be fixed in a spreadsheet and imported again. UTF-8 with a byte order mark,
 * which is what Excel needs to show umlauts correctly.
 */
export const rejectedCsv = (report: ImportReport) => {
  const delimiter = report.delimiter
  const row = (cells: string[]) => cells.map((cell) => escapeCell(cell, delimiter)).join(delimiter)
  const lines = [
    row([...report.header, 'line', 'reason']),
    ...report.rejectedRows.map((rejected) => row([...report.header.map((_, index) => rejected.fields[index] ?? ''), String(rejected.line), rejected.reasons.join(' ')])),
  ]
  return `﻿${lines.join('\r\n')}\r\n`
}
