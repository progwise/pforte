import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8')
const dockerfile = read('Dockerfile')
const bases = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((match) => match[1]!)

describe('the Dockerfile', () => {
  it('builds and runs on the same base image', () => {
    expect(bases).toHaveLength(2)
    expect(bases[0]).toBe(bases[1])
  })

  it('pins the base image by digest, so a build today is the build of tomorrow', () => {
    expect(bases[0]).toMatch(/^node:[\d.]+-alpine@sha256:[0-9a-f]{64}$/)
  })

  it('uses the Node version the tests run on (.nvmrc), and the one the package requires', () => {
    const nvmrc = read('.nvmrc').trim().replace(/^v/, '')
    const engines = (JSON.parse(read('package.json')) as { engines: { node: string } }).engines.node

    expect(bases[0]).toMatch(new RegExp(`^node:${nvmrc.replaceAll('.', '\\.')}-alpine@`))
    expect(engines).toContain(`>=${nvmrc}`)
  })

  it('runs as an unprivileged user, in production mode, with a healthcheck', () => {
    expect(dockerfile).toMatch(/^USER node$/m)
    expect(dockerfile).toMatch(/NODE_ENV=production/)
    expect(dockerfile).toMatch(/^HEALTHCHECK /m)
  })

  it('keeps secrets and the repository history out of the build', () => {
    const ignored = read('.dockerignore').split('\n')

    for (const entry of ['.git', '.env', '.env.*', '**/node_modules']) expect(ignored).toContain(entry)
  })
})
