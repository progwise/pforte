import { FakeApi } from '@progwise/pforte-import/testing'
import { describe, expect, it } from 'vitest'
import { type CliIo, runCli } from './main.js'

const ENV = { PFORTE_URL: 'https://id.example.com', PFORTE_CLIENT_ID: 'importer', PFORTE_CLIENT_SECRET: 's3cret' }

const setup = (files: Record<string, string>, api = new FakeApi()) => {
  const out: string[] = []
  const err: string[] = []
  const written = new Map<string, string>()
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    interactive: false,
    readFile: async (path) => {
      if (!(path in files)) throw Object.assign(new Error('nope'), { code: 'ENOENT' })
      return new TextEncoder().encode(files[path])
    },
    writeFile: async (path, content) => void written.set(path, content),
    createApi: () => api,
  }
  const run = (argv: string[], env: Record<string, string | undefined> = ENV) => runCli(argv, env, io)
  return { run, out: () => out.join('\n'), err: () => err.join(''), written, api }
}

const GOOD = 'email,first_name,last_name\nada@example.com,Ada,Lovelace\nbob@example.com,Bob,Builder\n'
const WITH_BAD_ROW = 'email,first_name,last_name,partner_no\nada@example.com,Ada,Lovelace,12345\nbad,Bob,Builder,1\n'

describe('pforte import', () => {
  it('shows the help and exits 0 for --help, 1 without arguments', async () => {
    const a = setup({})
    expect(await a.run(['--help'])).toBe(0)
    expect(a.out()).toContain('pforte import <file.csv>')
    const b = setup({})
    expect(await b.run([])).toBe(1)
  })

  it('imports a clean file and exits 0', async () => {
    const t = setup({ 'users.csv': GOOD })
    expect(await t.run(['import', 'users.csv'])).toBe(0)
    expect(t.out()).toContain('2  created')
    expect(t.api.users.size).toBe(2)
  })

  it('writes nothing in a dry run and says so', async () => {
    const t = setup({ 'users.csv': GOOD })
    expect(await t.run(['import', 'users.csv', '--dry-run'])).toBe(0)
    expect(t.out()).toContain('DRY RUN')
    expect(t.out()).toContain('would be created')
    expect(t.api.users.size).toBe(0)
  })

  it('exits 2 and writes the rejected rows with line and reason', async () => {
    const t = setup({ 'users.csv': WITH_BAD_ROW })
    expect(await t.run(['import', 'users.csv', '--rejected', 'rejected.csv', '--report', 'report.json'])).toBe(2)
    const rejected = t.written.get('rejected.csv')!
    expect(rejected.startsWith('﻿email,first_name,last_name,partner_no,line,reason\r\n')).toBe(true)
    expect(rejected).toContain('bad,Bob,Builder,1,3,')
    expect(JSON.parse(t.written.get('report.json')!).counts.rejected).toBe(1)
    expect(t.out()).toContain('written to rejected.csv')
  })

  it('writes no rejected file when nothing was rejected', async () => {
    const t = setup({ 'users.csv': GOOD })
    await t.run(['import', 'users.csv', '--rejected', 'rejected.csv'])
    expect(t.written.has('rejected.csv')).toBe(false)
  })

  it('exits 1 for a missing file', async () => {
    const t = setup({})
    expect(await t.run(['import', 'nope.csv'])).toBe(1)
    expect(t.err()).toContain('there is no such file')
  })

  it('exits 1 and names the missing settings', async () => {
    const t = setup({ 'users.csv': GOOD })
    expect(await t.run(['import', 'users.csv'], {})).toBe(1)
    expect(t.err()).toContain('PFORTE_URL, PFORTE_CLIENT_ID, PFORTE_CLIENT_SECRET')
  })

  it('reads the secret from a file', async () => {
    const t = setup({ 'users.csv': GOOD, secret: 'from-file\n' })
    const env = { PFORTE_URL: 'https://x', PFORTE_CLIENT_ID: 'importer', PFORTE_CLIENT_SECRET_FILE: 'secret' }
    expect(await t.run(['import', 'users.csv'], env)).toBe(0)
  })

  it('refuses both a secret and a secret file', async () => {
    const t = setup({ 'users.csv': GOOD, secret: 'x' })
    expect(await t.run(['import', 'users.csv'], { ...ENV, PFORTE_CLIENT_SECRET_FILE: 'secret' })).toBe(1)
    expect(t.err()).toContain('not both')
  })

  it.each([
    [['frobnicate', 'x.csv'], 'Unknown command'],
    [['import'], 'Which file?'],
    [['import', 'a.csv', 'b.csv'], 'extra arguments'],
    [['import', 'a.csv', '--missing', 'purge'], '--missing must be one of'],
    [['import', 'a.csv', '--max-missing-percent', '101'], '--max-missing-percent'],
    [['import', 'a.csv', '--concurrency', '0'], '--concurrency'],
    [['import', 'a.csv', '--value-separator', ';;'], 'single character'],
    [['import', 'a.csv', '--encoding', 'latin9'], '--encoding'],
    [['import', 'a.csv', '--nonsense'], 'Try: pforte --help'],
  ])('rejects %j', async (argv, message) => {
    const t = setup({ 'a.csv': GOOD })
    expect(await t.run(argv)).toBe(1)
    expect(t.err()).toContain(message)
  })

  it('refuses --missing=delete without --allow-delete', async () => {
    const t = setup({ 'users.csv': GOOD })
    t.api.seed('old@example.com')
    expect(await t.run(['import', 'users.csv', '--missing', 'delete'])).toBe(1)
    expect(t.api.users.has('old@example.com')).toBe(true)
  })

  it('locks users who are not in the file and reports them', async () => {
    const t = setup({ 'users.csv': GOOD })
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) t.api.seed(`${name}@example.com`)
    t.api.seed('ada@example.com')
    t.api.seed('bob@example.com')
    t.api.seed('gone@example.com')
    expect(await t.run(['import', 'users.csv', '--missing', 'lock', '--force'])).toBe(0)
    expect(t.api.users.get('gone@example.com')?.status).toBe('locked')
    expect(t.out()).toContain('--missing=lock')
  })

  it('exits 2 when the API could not be reached for a row', async () => {
    const t = setup({ 'users.csv': GOOD })
    t.api.unreachable.add('bob@example.com')
    expect(await t.run(['import', 'users.csv'])).toBe(2)
    expect(t.out()).toContain('1  failed')
  })

  it('exits 1 when the credentials are refused', async () => {
    const t = setup({ 'users.csv': GOOD })
    t.api.refuseWith = 403
    expect(await t.run(['import', 'users.csv'])).toBe(1)
  })

  it('escapes delimiters and quotes in the rejected file', async () => {
    const t = setup({ 'users.csv': 'email;first_name;last_name\n"bad;mail";"Bo ""B""";X\n' })
    expect(await t.run(['import', 'users.csv', '--rejected', 'r.csv'])).toBe(2)
    expect(t.written.get('r.csv')).toContain('"bad;mail";"Bo ""B""";X;2;')
  })
})

describe('dry run changes', () => {
  it('lists a new user briefly and shows what changes for an existing one', async () => {
    const api = new FakeApi()
    api.seed('bob@example.com')
    const t = setup({ 'users.csv': GOOD }, api)
    await t.run(['import', 'users.csv', '--dry-run'])
    expect(t.out()).toContain('line 2: ada@example.com — new user')
    expect(t.out()).toMatch(/line 3: bob@example.com — updated; firstName: Old → Bob/)
  })
})
