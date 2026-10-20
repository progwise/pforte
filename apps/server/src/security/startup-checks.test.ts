import { hash } from '@node-rs/argon2'
import { seed } from '@progwise/pforte-db/seed'
import { createTestDatabase, hasDatabase } from '@progwise/pforte-db/testing'
import { generateKeyPairSync } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Config, loadConfig } from '../config.js'
import { checkConfig, checkDevelopmentLeftovers, startupFailure } from './startup-checks.js'

const jwk = (modulusLength = 2048) => ({ ...generateKeyPairSync('rsa', { modulusLength }).privateKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' })
const goodEnv = () => ({
  DATABASE_URL: 'postgres://pforte:Yc7vJ2xqL9mQ4sBw@db.internal:5432/pforte',
  ISSUER: 'https://id.example.com',
  COOKIE_KEYS: 'Qm9u7Zk3Vx1Lp8Ta5Yd2Wc6Hf4Rg0NjSe9Ub7Ki3Ao1Xz5Cq',
  JWKS: JSON.stringify({ keys: [jwk()] }),
  SMTP_URL: 'smtp://user:pass@mail.example.com:587',
  MAIL_FROM: 'no-reply@example.com',
  NODE_ENV: 'production',
})
const config = (override: Record<string, string | undefined> = {}): Config => loadConfig({ ...goodEnv(), ...override })

describe('configuration for production', () => {
  it('is fine with a real https address, database password, keys and mail', () => {
    expect(checkConfig(config())).toEqual([])
  })

  it('knows it is production', () => {
    expect(config().production).toBe(true)
    expect(config({ NODE_ENV: undefined }).production).toBe(false)
  })

  it('wants https', () => {
    const [problem] = checkConfig(config({ ISSUER: 'http://localhost:3300' }))
    expect(problem).toMatch(/ISSUER is http:\/\/localhost:3300.*https/)
  })

  it.each(['pforte', 'postgres', 'Password', 'changeme', ''])('refuses the database password "%s"', (password) => {
    const problems = checkConfig(config({ DATABASE_URL: `postgres://pforte:${password}@db:5432/pforte` }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/DATABASE_URL.*default/)
  })

  it('does not print the password it refuses', () => {
    expect(checkConfig(config({ DATABASE_URL: 'postgres://pforte:postgres@db:5432/pforte' })).join()).not.toContain('postgres@')
  })

  it('refuses cookie keys that are long but easy to guess, and says which one', () => {
    const problems = checkConfig(config({ COOKIE_KEYS: `${goodEnv().COOKIE_KEYS},${'k'.repeat(40)},${'ab'.repeat(20)}` }))
    expect(problems).toHaveLength(2)
    expect(problems[0]).toMatch(/Cookie key 2/)
    expect(problems[1]).toMatch(/Cookie key 3/)
  })

  it('refuses a small RSA key and a weak curve', () => {
    expect(checkConfig(config({ JWKS: JSON.stringify({ keys: [jwk(1024)] }) })).join()).toMatch(/RSA key of less than 2048 bits/)
    const weak = { kty: 'EC', crv: 'secp256k1', kid: 'e1', d: 'x', x: 'x', y: 'y' }
    expect(checkConfig(config({ JWKS: JSON.stringify({ keys: [weak] }) })).join()).toMatch(/curve secp256k1/)
    const odd = { kty: 'oct', kid: 'o1', d: 'x', k: 'y' }
    expect(checkConfig(config({ JWKS: JSON.stringify({ keys: [odd] }) })).join()).toMatch(/has type oct/)
  })

  it('accepts a P-256 key', () => {
    const ec = { ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }), kid: 'e1' }
    expect(checkConfig(config({ JWKS: JSON.stringify({ keys: [ec] }) }))).toEqual([])
  })

  it('wants a way to send codes, since nobody can sign in without one', () => {
    const problems = checkConfig(config({ SMTP_URL: undefined, MAIL_FROM: undefined }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/SMTP_URL and MAIL_FROM are not set/)
  })

  it('lists everything at once, so it can be fixed in one go', () => {
    const problems = checkConfig(config({ ISSUER: 'http://localhost:3300', DATABASE_URL: 'postgres://u:pforte@db/x', SMTP_URL: undefined, MAIL_FROM: undefined }))
    expect(problems).toHaveLength(3)
    const message = startupFailure(problems)
    expect(message).toMatch(/^pforte will not start in production/)
    expect(message.split('\n')).toHaveLength(4)
  })
})

describe.skipIf(!hasDatabase)('what the development seed leaves behind', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  afterAll(async () => {
    await database?.drop()
  })

  it('finds nothing in an empty database', async () => {
    expect(await checkDevelopmentLeftovers(database.db)).toEqual([])
  })

  it('names the clients with the development secret and the users with the development password', async () => {
    await seed(database.db)
    const problems = await checkDevelopmentLeftovers(database.db)

    const clients = problems.filter((problem) => problem.startsWith('The client'))
    expect(clients.length).toBeGreaterThanOrEqual(3)
    expect(clients.join()).toMatch(/"demo-admin".*rotate-secret/)
    const users = problems.filter((problem) => /user\(s\) still have the development password/.test(problem))
    expect(users).toHaveLength(1)
    expect(users[0]).toMatch(/^\d+ user\(s\).*@example\.com.*and \d+ more\)/)
    expect(problems.join('\n')).not.toMatch(/dev-secret|dev-password/)
  })

  it('is quiet once the secrets and passwords are changed', async () => {
    const secret = await hash('a-long-random-secret-of-a-real-installation')
    await database.pool.query(`update clients set secret_hash = $1 where secret_hash is not null`, [secret])
    await database.pool.query(`update users set password_hash = $1 where password_hash is not null`, [secret])
    expect(await checkDevelopmentLeftovers(database.db)).toEqual([])
  })

  it('does not mistake a real user for a development user', async () => {
    await database.pool.query(
      `insert into users (email, first_name, last_name, password_hash, status) values ('real.person@company.de', 'R', 'P', $1, 'active')`,
      [await hash('dev-password')],
    )
    expect(await checkDevelopmentLeftovers(database.db)).toEqual([])
  })
})
