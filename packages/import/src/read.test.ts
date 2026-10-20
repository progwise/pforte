import { describe, expect, it } from 'vitest'
import { ImportFileError } from './errors.js'
import { readCsv } from './read.js'

const bytes = (text: string) => new TextEncoder().encode(text)
const windows1252 = (text: string) => Uint8Array.from([...text].map((char) => (char === 'ü' ? 0xfc : char === 'ö' ? 0xf6 : char === 'ä' ? 0xe4 : char.charCodeAt(0))))

describe('reading a CSV file', () => {
  it('reads a comma-separated file', () => {
    const file = readCsv(bytes('email,first_name,last_name\nanna@example.com,Anna,Schmidt\n'))

    expect(file.delimiter).toBe(',')
    expect(file.header).toEqual(['email', 'first_name', 'last_name'])
    expect(file.rows).toEqual([{ line: 2, fields: ['anna@example.com', 'Anna', 'Schmidt'] }])
  })

  it('detects a semicolon, as written by Excel in Germany', () => {
    const file = readCsv(bytes('email;first_name;last_name\nanna@example.com;Anna;Schmidt\n'))

    expect(file.delimiter).toBe(';')
    expect(file.rows[0]!.fields).toEqual(['anna@example.com', 'Anna', 'Schmidt'])
  })

  it('does not count separators inside quoted header names', () => {
    expect(readCsv(bytes('"a;b",c,d\n1,2,3\n')).delimiter).toBe(',')
  })

  it('accepts a UTF-8 byte order mark', () => {
    const file = readCsv(bytes('﻿email,first_name,last_name\na@example.com,A,B\n'))

    expect(file.header[0]).toBe('email')
  })

  it('keeps umlauts and other characters of UTF-8', () => {
    const file = readCsv(bytes('email,first_name,last_name\nj@example.com,Jürgen,Müller-Łukasz\n'))

    expect(file.rows[0]!.fields).toEqual(['j@example.com', 'Jürgen', 'Müller-Łukasz'])
  })

  it('reports the line each row starts on, also after blank lines and quoted line breaks', () => {
    const file = readCsv(bytes('email,first_name,last_name\na@example.com,"Multi\nline",X\n\nb@example.com,B,Y\r\nc@example.com,C,Z'))

    expect(file.rows.map((row) => row.line)).toEqual([2, 5, 6])
    expect(file.rows[0]!.fields[1]).toBe('Multi\nline')
  })

  it('skips rows that hold only empty cells, which Excel leaves at the end', () => {
    const file = readCsv(bytes('email;first_name;last_name\na@example.com;A;B\n;;\n ; ; \n'))

    expect(file.rows).toHaveLength(1)
  })

  it('reports the same lines for a file with Windows line ends, as Excel writes them', () => {
    const file = readCsv(bytes('email,first_name,last_name\r\na@example.com,"Multi\r\nline",X\r\n\r\nb@example.com,B,Y\r\nc@example.com,C,Z\r\n'))

    expect(file.rows.map((row) => row.line)).toEqual([2, 5, 6])
    expect(file.rows[0]!.fields[1]).toBe('Multi\r\nline')
  })

  it('keeps a row with the wrong number of cells, to be rejected with its line', () => {
    const file = readCsv(bytes('email,first_name,last_name\na@example.com,A\nb@example.com,B,C,D\n'))

    expect(file.rows.map((row) => row.fields.length)).toEqual([2, 4])
  })

  describe('encodings', () => {
    it('refuses a Windows-1252 file with a hint how to export it', () => {
      expect(() => readCsv(windows1252('email,first_name,last_name\nj@example.com,Jürgen,Müller\n'))).toThrow(ImportFileError)
      expect(() => readCsv(windows1252('email,first_name,last_name\nj@example.com,Jürgen,Müller\n'))).toThrow(/CSV UTF-8.*--encoding windows-1252/s)
    })

    it('reads a Windows-1252 file when asked to', () => {
      const file = readCsv(windows1252('email;first_name;last_name\nj@example.com;Jürgen;Müller\n'), { encoding: 'windows-1252' })

      expect(file.rows[0]!.fields).toEqual(['j@example.com', 'Jürgen', 'Müller'])
    })
  })

  describe('files that cannot be read', () => {
    it('refuses an empty file', () => {
      expect(() => readCsv(bytes(''))).toThrow('The file is empty.')
      expect(() => readCsv(bytes('  \n\n'))).toThrow('The file is empty.')
    })

    it('refuses broken quoting and names the line', () => {
      expect(() => readCsv(bytes('email,first_name,last_name\na@example.com,"unterminated,B\n'))).toThrow(/not valid CSV.*line 2/)
    })

    it('reads a file with only a header as having no rows', () => {
      expect(readCsv(bytes('email,first_name,last_name\n')).rows).toEqual([])
    })
  })
})
