import { describe, expect, it } from 'vitest'
import { type ClaimTypeInfo, classifyColumns } from './columns.js'
import { readCsv } from './read.js'
import { validateRows } from './rows.js'

const claimTypes: ClaimTypeInfo[] = [
  { key: 'partner_no', multiValued: true, valuePattern: '^[0-9]{5}$' },
  { key: 'customer_no', multiValued: false, valuePattern: '^[0-9]{5}$' },
  { key: 'branch_code', multiValued: false, valuePattern: null },
]

const run = (csv: string, options: { separator?: string } = {}) => {
  const file = readCsv(new TextEncoder().encode(csv))
  const columns = classifyColumns(file.header, claimTypes)
  return validateRows(file, columns, claimTypes, { valueSeparator: options.separator })
}

const HEADER = 'email,first_name,last_name,phone,language,partner_no,customer_no\n'

describe('validating rows', () => {
  it('normalizes a good row the way the API expects it', () => {
    const { valid, rejected } = run(`${HEADER} Anna.Schmidt@Example.COM , Anna , Schmidt ,+49 151 1234567,DE,00892;00893,10001\n`)

    expect(rejected).toEqual([])
    expect(valid).toEqual([
      {
        line: 2,
        email: 'anna.schmidt@example.com',
        firstName: 'Anna',
        lastName: 'Schmidt',
        phone: '+491511234567',
        language: 'de',
        claims: { partner_no: ['00892', '00893'], customer_no: ['10001'] },
      },
    ])
  })

  describe('phone numbers', () => {
    it.each([
      ['+49 (151) 123-4567', '+491511234567'],
      ['0049 151 1234567', '+491511234567'],
      ['+49/151/1234567', '+491511234567'],
    ])('reads %s as %s', (written, expected) => {
      expect(run(`${HEADER}a@example.com,A,B,"${written}",,,\n`).valid[0]!.phone).toBe(expected)
    })

    it('rejects a national number with a hint', () => {
      const { rejected } = run(`${HEADER}a@example.com,A,B,0151 1234567,,,\n`)

      expect(rejected[0]!.reasons).toEqual(['The phone number "0151 1234567" must be in international format, e.g. +4915112345678.'])
    })

    it('clears the phone for a blank cell and leaves it alone when the file has no phone column', () => {
      expect(run(`${HEADER}a@example.com,A,B,,,,\n`).valid[0]!.phone).toBeNull()
      expect(run('email,first_name,last_name\na@example.com,A,B\n').valid[0]).not.toHaveProperty('phone')
    })
  })

  describe('claims', () => {
    it('clears a claim type for a blank cell, because a column means the file is the truth for that type', () => {
      expect(run(`${HEADER}a@example.com,A,B,,,,\n`).valid[0]!.claims).toEqual({ partner_no: [], customer_no: [] })
    })

    it('does not mention claim types that are not columns', () => {
      expect(run('email,first_name,last_name,partner_no\na@example.com,A,B,00001\n').valid[0]!.claims).toEqual({ partner_no: ['00001'] })
    })

    it('trims, drops empty values and removes duplicates', () => {
      expect(run(`${HEADER}a@example.com,A,B,,,00001; 00002 ;;00001,\n`).valid[0]!.claims.partner_no).toEqual(['00001', '00002'])
    })

    it('uses another value separator when asked, which is how a comma-separated file can hold several values', () => {
      const result = run('email;first_name;last_name;partner_no\na@example.com;A;B;00001|00002\n', { separator: '|' })

      expect(result.valid[0]!.claims.partner_no).toEqual(['00001', '00002'])
    })

    it('rejects a value that does not match the pattern of its claim type', () => {
      expect(run(`${HEADER}a@example.com,A,B,,,abc,\n`).rejected[0]!.reasons).toEqual(['partner_no: "abc" does not match the pattern ^[0-9]{5}$.'])
    })

    it('rejects several values for a single-valued type', () => {
      expect(run(`${HEADER}a@example.com,A,B,,,,10001;10002\n`).rejected[0]!.reasons[0]).toContain('customer_no: only one value is allowed, but the cell has 2')
    })
  })

  describe('rejecting rows', () => {
    it('lists every problem of a row at once, with its line', () => {
      const { rejected } = run(`${HEADER}not-an-email,,Schmidt,+49,xx1,abc,\n`)

      expect(rejected).toHaveLength(1)
      expect(rejected[0]!.line).toBe(2)
      expect(rejected[0]!.reasons).toEqual([
        '"not-an-email" is not a valid e-mail address.',
        'The first name is missing.',
        'The phone number "+49" must be in international format, e.g. +4915112345678.',
        'The language "xx1" must be a code such as de or en.',
        'partner_no: "abc" does not match the pattern ^[0-9]{5}$.',
      ])
      expect(rejected[0]!.fields).toHaveLength(7)
    })

    it('rejects a missing e-mail address and a missing last name', () => {
      const { rejected } = run(`${HEADER},Anna,,,,,\n`)

      expect(rejected[0]!.reasons).toEqual(['The e-mail address is missing.', 'The last name is missing.'])
    })

    it('rejects a row with the wrong number of cells', () => {
      const { rejected } = run(`${HEADER}a@example.com,A,B\n`)

      expect(rejected[0]!.reasons[0]).toBe('The row has 3 cells, but the header has 7 columns.')
    })

    it('rejects the later one of two rows with the same e-mail, naming the earlier line, in any case', () => {
      const { valid, rejected } = run(`${HEADER}a@example.com,A,B,,,,\nb@example.com,B,B,,,,\nA@Example.com,A2,B2,,,,\n`)

      expect(valid.map((row) => row.line)).toEqual([2, 3])
      expect(rejected).toEqual([expect.objectContaining({ line: 4, reasons: ['The e-mail address a@example.com already appeared on line 2.'] })])
    })

    it('imports the good rows around a rejected one', () => {
      const { valid, rejected } = run(`${HEADER}a@example.com,A,B,,,,\nbroken,,,,,,\nc@example.com,C,D,,,,\n`)

      expect(valid.map((row) => row.email)).toEqual(['a@example.com', 'c@example.com'])
      expect(rejected.map((row) => row.line)).toEqual([3])
    })
  })

  describe('which e-mails are present in the file', () => {
    it('includes rejected rows, so a typo elsewhere in a row can never make that person "missing"', () => {
      const { presentEmails } = run(`${HEADER}ok@example.com,A,B,,,,\nTypo@Example.com,A,B,not a phone,,,\n,,,,,,\n`)

      expect([...presentEmails].sort()).toEqual(['ok@example.com', 'typo@example.com'])
    })

    it('includes the repeated address, and an address that is not valid cannot match any user anyway', () => {
      const { presentEmails } = run(`${HEADER}dup@example.com,A,B,,,,\nDUP@example.com,A,B,,,,\n`)

      expect([...presentEmails]).toEqual(['dup@example.com'])
    })
  })
})
