import { createPrivateKey, createSign, createVerify, createPublicKey } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'
import { generateKeys, keysAsEnvironment, KEY_FILES, writeKeyFiles } from './keys.js'
import { checkConfig } from './security/startup-checks.js'

const directories: string[] = []
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), 'pforte-keys-'))
  directories.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('generated keys', () => {
  it('are new every time', () => {
    const [one, two] = [generateKeys(), generateKeys()]

    expect(one.cookieKeys).not.toBe(two.cookieKeys)
    expect(one.jwks).not.toBe(two.jwks)
  })

  it('sign and verify tokens, and the public part of the key set is derived from them', () => {
    const { keys } = JSON.parse(generateKeys().jwks) as { keys: (Record<string, string> & { kid: string })[] }
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' })
    expect(keys[0]!.kid).toMatch(/^[0-9a-f]{16}$/)

    const privateKey = createPrivateKey({ key: keys[0] as never, format: 'jwk' })
    const signature = createSign('RSA-SHA256').update('token').sign(privateKey)
    expect(createVerify('RSA-SHA256').update('token').verify(createPublicKey(privateKey), signature)).toBe(true)
  })

  it('are accepted by pforte in production, with nothing to complain about but the mail settings', () => {
    const keys = generateKeys()
    const config = loadConfig({ DATABASE_URL: 'postgres://pforte:a-long-random-password-1f3c@db/pforte', ISSUER: 'https://id.example.com', COOKIE_KEYS: keys.cookieKeys, JWKS: keys.jwks, NODE_ENV: 'production' })

    expect(checkConfig(config).filter((problem) => !problem.startsWith('SMTP_URL'))).toEqual([])
  })

  it('print as lines of an environment file, without quotes, which docker run --env-file would keep in the value', () => {
    const keys = generateKeys()

    const lines = keysAsEnvironment(keys).trimEnd().split('\n')

    expect(lines).toEqual([`COOKIE_KEYS=${keys.cookieKeys}`, `JWKS=${keys.jwks}`])
    expect(keys.jwks).not.toMatch(/[\s'#$]/)
    expect(JSON.parse(lines[1]!.slice('JWKS='.length))).toEqual(JSON.parse(keys.jwks))
  })
})

describe('key files', () => {
  it('are written for the owner alone, with what COOKIE_KEYS_FILE and JWKS_FILE read', () => {
    const directory = temporary()
    const keys = generateKeys()

    writeKeyFiles(directory, keys)

    for (const name of Object.values(KEY_FILES)) expect(statSync(join(directory, name)).mode & 0o777).toBe(0o600)
    const config = loadConfig({
      DATABASE_URL: 'postgres://u:p@h/d',
      ISSUER: 'https://id.example.com',
      COOKIE_KEYS_FILE: join(directory, KEY_FILES.cookieKeys),
      JWKS_FILE: join(directory, KEY_FILES.jwks),
    })
    expect(config.cookieKeys).toEqual([keys.cookieKeys])
    expect(config.jwks.keys).toHaveLength(1)
  })

  it('create the directory when it is missing', () => {
    const directory = join(temporary(), 'deeper', 'secrets')

    writeKeyFiles(directory, generateKeys())

    expect(existsSync(join(directory, KEY_FILES.jwks))).toBe(true)
  })

  it('never replace keys that exist, which would sign everybody out', () => {
    const directory = temporary()
    writeKeyFiles(directory, generateKeys())
    const before = readFileSync(join(directory, KEY_FILES.jwks), 'utf8')

    expect(() => writeKeyFiles(directory, generateKeys())).toThrow(/already exist.*sign everybody out.*--force/)
    expect(readFileSync(join(directory, KEY_FILES.jwks), 'utf8')).toBe(before)
  })

  it('refuse to replace even one existing file, and write none of them', () => {
    const directory = temporary()
    writeFileSync(join(directory, KEY_FILES.jwks), 'keep me')

    expect(() => writeKeyFiles(directory, generateKeys())).toThrow(/already exists/)
    expect(existsSync(join(directory, KEY_FILES.cookieKeys))).toBe(false)
  })

  it('replace keys when told to', () => {
    const directory = temporary()
    writeKeyFiles(directory, generateKeys())
    const before = readFileSync(join(directory, KEY_FILES.jwks), 'utf8')

    writeKeyFiles(directory, generateKeys(), { force: true })

    expect(readFileSync(join(directory, KEY_FILES.jwks), 'utf8')).not.toBe(before)
  })
})
