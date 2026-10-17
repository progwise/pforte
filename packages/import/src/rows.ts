import { z } from 'zod'
import type { ClaimTypeInfo, Columns } from './columns.js'
import type { ReadFile } from './read.js'

/** A row that passed the checks, normalized the way the admin API expects it. */
export interface ImportRow {
  line: number
  email: string
  firstName: string
  lastName: string
  /** `undefined`: the file has no phone column, leave it. `null`: the cell was blank, clear it. */
  phone?: string | null
  language?: string
  /** Only the claim types that are columns of the file; an empty list clears that type. */
  claims: Record<string, string[]>
}

export interface RejectedRow {
  line: number
  reasons: string[]
  /** The cells as they were in the file, to write the rejected rows back out. */
  fields: string[]
}

export interface ValidatedRows {
  valid: ImportRow[]
  rejected: RejectedRow[]
  /** Every e-mail in the file, rejected rows included, so a typo elsewhere in a row never makes someone "missing". */
  presentEmails: Set<string>
}

const emailSchema = z.email()
const PHONE = /^\+[1-9]\d{6,14}$/
const LANGUAGE = /^[a-z]{2,3}$/
const MAX_LENGTH = 200

/** "+49 151 1234567", "0049-151-1234567" and "+49 (151) 1234567" all become +491511234567. */
const normalizePhone = (value: string) => {
  const stripped = value.replace(/[\s\-./()]/g, '')
  return stripped.startsWith('00') ? `+${stripped.slice(2)}` : stripped
}

const matches = (pattern: string | null, value: string) => {
  if (pattern === null) return true
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return true
  }
}

/** Checks every row. A row with any problem is rejected as a whole, with all its problems listed. */
export const validateRows = (
  file: ReadFile,
  columns: Columns,
  claimTypes: ClaimTypeInfo[],
  { valueSeparator = ';' }: { valueSeparator?: string } = {},
): ValidatedRows => {
  const types = new Map(claimTypes.map((claimType) => [claimType.key, claimType]))
  const indexOf = (name: string) => columns.byIndex.findIndex((column) => column?.kind === 'fixed' && column.name === name)
  const emailIndex = indexOf('email')
  const firstNameIndex = indexOf('first_name')
  const lastNameIndex = indexOf('last_name')
  const phoneIndex = indexOf('phone')
  const languageIndex = indexOf('language')

  const valid: ImportRow[] = []
  const rejected: RejectedRow[] = []
  const presentEmails = new Set<string>()
  const firstLineOf = new Map<string, number>()

  for (const { line, fields } of file.rows) {
    const reasons: string[] = []
    const cell = (index: number) => (fields[index] ?? '').trim()
    const email = cell(emailIndex).toLowerCase()
    if (email) presentEmails.add(email)

    if (fields.length !== file.header.length) {
      reasons.push(`The row has ${fields.length} cells, but the header has ${file.header.length} columns.`)
    }

    if (!emailSchema.safeParse(email).success) {
      reasons.push(email ? `"${email}" is not a valid e-mail address.` : 'The e-mail address is missing.')
    } else if (firstLineOf.has(email)) {
      reasons.push(`The e-mail address ${email} already appeared on line ${firstLineOf.get(email)}.`)
    } else {
      firstLineOf.set(email, line)
    }

    const firstName = cell(firstNameIndex)
    const lastName = cell(lastNameIndex)
    if (!firstName) reasons.push('The first name is missing.')
    if (!lastName) reasons.push('The last name is missing.')
    if (firstName.length > MAX_LENGTH || lastName.length > MAX_LENGTH) reasons.push(`Names may have at most ${MAX_LENGTH} characters.`)

    let phone: string | null | undefined
    if (columns.has.phone) {
      const raw = cell(phoneIndex)
      phone = raw === '' ? null : normalizePhone(raw)
      if (phone !== null && !PHONE.test(phone)) {
        reasons.push(`The phone number "${raw}" must be in international format, e.g. +4915112345678.`)
      }
    }

    let language: string | undefined
    if (columns.has.language) {
      const raw = cell(languageIndex).toLowerCase()
      if (raw !== '') {
        language = raw
        if (!LANGUAGE.test(raw)) reasons.push(`The language "${raw}" must be a code such as de or en.`)
      }
    }

    const claims: Record<string, string[]> = {}
    columns.byIndex.forEach((column, index) => {
      if (column?.kind !== 'claim') return
      const claimType = types.get(column.key)!
      const values = [...new Set(cell(index).split(valueSeparator).map((value) => value.trim()).filter(Boolean))]
      claims[column.key] = values

      if (!claimType.multiValued && values.length > 1) {
        reasons.push(`${column.key}: only one value is allowed, but the cell has ${values.length} (${values.join(', ')}).`)
      }
      for (const value of values) {
        if (value.length > MAX_LENGTH) reasons.push(`${column.key}: a value is longer than ${MAX_LENGTH} characters.`)
        else if (!matches(claimType.valuePattern, value)) {
          reasons.push(`${column.key}: "${value}" does not match the pattern ${claimType.valuePattern}.`)
        }
      }
    })

    if (reasons.length > 0) rejected.push({ line, reasons, fields })
    else valid.push({ line, email, firstName, lastName, ...(phone !== undefined && { phone }), ...(language && { language }), claims })
  }

  return { valid, rejected, presentEmails }
}
