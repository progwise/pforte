import { describe, expect, it } from 'vitest'
import { classifyColumns, type ClaimTypeInfo, normalizeColumn, suggestClaimType } from './columns.js'
import { ImportFileError } from './errors.js'

const claimTypes: ClaimTypeInfo[] = [
  { key: 'partner_no', multiValued: true, valuePattern: '^[0-9]{5}$' },
  { key: 'customer_no', multiValued: false, valuePattern: null },
  { key: 'branch_code', multiValued: false, valuePattern: null },
]

describe('column names', () => {
  it.each([
    ['E-Mail', 'email'],
    [' email ', 'email'],
    ['First Name', 'first_name'],
    ['Vorname ', 'vorname'],
    ['firstname', 'first_name'],
    ['Last-Name', 'last_name'],
    ['surname', 'last_name'],
    ['Partner No', 'partner_no'],
  ])('reads "%s" as %s', (written, expected) => {
    expect(normalizeColumn(written)).toBe(expected)
  })
})

describe('classifying the header', () => {
  it('recognizes standard columns and claim types, and remembers which optional columns exist', () => {
    const columns = classifyColumns(['email', 'first_name', 'last_name', 'phone', 'partner_no'], claimTypes)

    expect(columns.claimColumns).toEqual(['partner_no'])
    expect(columns.has).toEqual({ email: true, first_name: true, last_name: true, phone: true, language: false })
    expect(columns.byIndex.map((column) => column?.kind)).toEqual(['fixed', 'fixed', 'fixed', 'fixed', 'claim'])
  })

  it('accepts friendly spellings of the header', () => {
    const columns = classifyColumns(['E-Mail', 'First Name', 'Last Name', 'Partner No'], claimTypes)

    expect(columns.has.email && columns.has.first_name && columns.has.last_name).toBe(true)
    expect(columns.claimColumns).toEqual(['partner_no'])
  })

  it('needs e-mail, first name and last name, and says which are missing', () => {
    expect(() => classifyColumns(['email', 'partner_no'], claimTypes)).toThrow(/needs the columns first_name, last_name/)
  })

  describe('unknown columns', () => {
    it('abort the import and suggest the closest claim type', () => {
      const attempt = () => classifyColumns(['email', 'first_name', 'last_name', 'partnr_no'], claimTypes)

      expect(attempt).toThrow(ImportFileError)
      expect(attempt).toThrow(/"partnr_no" \(did you mean "partner_no"\?\)/)
      expect(attempt).toThrow(/--ignore-unknown-columns/)
    })

    it('are listed all at once, with no suggestion when nothing is close', () => {
      const attempt = () => classifyColumns(['email', 'first_name', 'last_name', 'shoe_size', 'costcenter'], claimTypes)

      expect(attempt).toThrow(/"shoe_size", "costcenter"/)
      expect(attempt).not.toThrow(/did you mean "(partner_no|customer_no|branch_code)"/)
    })

    it('are skipped with a warning when asked to', () => {
      const columns = classifyColumns(['email', 'first_name', 'last_name', 'shoe_size'], claimTypes, { ignoreUnknown: true })

      expect(columns.byIndex[3]).toBeUndefined()
      expect(columns.warnings).toEqual(['The column "shoe_size" is not a claim type and was ignored.'])
    })
  })

  it('refuses a column that appears twice, also under another spelling', () => {
    expect(() => classifyColumns(['email', 'E-Mail', 'first_name', 'last_name'], claimTypes)).toThrow(/appears twice/)
  })

  it('ignores an unnamed column unless it holds data', () => {
    const header = ['email', 'first_name', 'last_name', '']

    expect(classifyColumns(header, claimTypes, { dataInColumn: () => false }).byIndex[3]).toBeUndefined()
    expect(() => classifyColumns(header, claimTypes, { dataInColumn: (index) => index === 3 })).toThrow(/Column 4 has no name but contains data/)
  })
})

describe('suggesting a claim type', () => {
  const known = claimTypes.map((claimType) => claimType.key)

  it.each([
    ['partnr_no', 'partner_no'],
    ['Partner No', 'partner_no'],
    ['customer_nr', 'customer_no'],
    ['branchcode', 'branch_code'],
  ])('suggests %s → %s', (column, expected) => {
    expect(suggestClaimType(column, known)).toBe(expected)
  })

  it('suggests nothing for a name that is not close to any', () => {
    expect(suggestClaimType('shoe_size', known)).toBeUndefined()
  })
})
