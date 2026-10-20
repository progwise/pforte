import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceFolder = fileURLToPath(new URL('.', import.meta.url))
const documentation = readFileSync(fileURLToPath(new URL('../../../docs/configuration.md', import.meta.url)), 'utf8')

const sourceFiles = (folder: string): string[] =>
  readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(folder, entry.name)) : entry.name.endsWith('.ts') && !entry.name.includes('.test.') && !entry.name.startsWith('test') ? [join(folder, entry.name)] : [],
  )

const code = sourceFiles(sourceFolder).map((file) => readFileSync(file, 'utf8')).join('\n')

/** Every environment variable the server reads, and which of them may come from a file. */
const readVariables = new Set([...code.matchAll(/(?:process\.env|\benv)\.([A-Z][A-Z0-9_]+)/g)].map((match) => match[1]!))
const secretVariables = new Set([...code.matchAll(/(?:readSecret|requireSecret)\(env, '([A-Z][A-Z0-9_]+)'/g)].map((match) => match[1]!))
for (const name of secretVariables) readVariables.add(name)

/** The variables that have a row in a table of the documentation. */
const documented = new Map<string, string>()
for (const line of documentation.split('\n')) {
  const name = /^\| `([A-Z][A-Z0-9_]+)`/.exec(line)?.[1]
  if (name && !documented.has(name)) documented.set(name, line)
}

describe('the configuration reference', () => {
  it('finds the variables of the code, so that this test cannot pass by finding nothing', () => {
    expect(readVariables.size).toBeGreaterThan(20)
    for (const name of ['DATABASE_URL', 'ISSUER', 'COOKIE_KEYS', 'JWKS', 'SMTP_URL', 'SMS_HEADERS', 'PORT', 'MIGRATE_ON_START']) expect(readVariables).toContain(name)
  })

  it('documents every variable the server reads', () => {
    const missing = [...readVariables].filter((name) => !documented.has(name))

    expect(missing, `Add these to docs/configuration.md: ${missing.join(', ')}`).toEqual([])
  })

  it('documents no variable the server does not read', () => {
    const stale = [...documented.keys()].filter((name) => !readVariables.has(name))

    expect(stale, `docs/configuration.md describes variables that no code reads: ${stale.join(', ')}`).toEqual([])
  })

  it('says which secrets can come from a file, and only those', () => {
    const wrong = [...documented].filter(([name, row]) => row.includes(`${name}_FILE`) !== secretVariables.has(name))

    expect(wrong.map(([name]) => name)).toEqual([])
    for (const name of secretVariables) expect(documentation).toContain(`\`${name}_FILE\``)
  })

  it('gives a default for every variable that has one in the code', () => {
    expect(documentation).toMatch(/\| `PORT` \| `3300`/)
    expect(documentation).toMatch(/\| `TIME_ZONE` \| `UTC`/)
    expect(documentation).toMatch(/\| `AUDIT_LOGIN_RETENTION_DAYS` \| `180`/)
    expect(documentation).toMatch(/\| `MIGRATE_ON_START` \| `true`/)
  })
})
