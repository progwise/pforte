import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  checkCode,
  CodeLimitError,
  CODE_LIFETIME_MS,
  deleteOldCodes,
  issueCode,
  markEmailVerified,
  MAX_CODES_PER_HOUR,
  RESEND_COOLDOWN_MS,
} from './codes.js'
import { createTestDatabase, hasDatabase } from './test/test-database.js'

const secrets = ['first-secret-first-secret-first-secret', 'old-secret-old-secret-old-secret-old']
const minutes = (count: number) => count * 60 * 1000

describe.skipIf(!hasDatabase)('one-time codes', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>
  let counter = 0
  const start = new Date('2030-01-01T10:00:00Z')

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  afterAll(async () => {
    await database?.drop()
  })

  const newUser = async () => {
    const { rows } = await database.pool.query(
      `insert into users (email, first_name, last_name) values ($1, 'C', 'D') returning id`,
      [`code${++counter}@example.com`],
    )
    return rows[0].id as string
  }
  const issue = async (userId: string, now = start, purpose: 'login' | 'password_reset' = 'login') =>
    issueCode(database.db, { userId, channel: 'email', purpose }, { secrets, now })
  const check = (userId: string, code: string, now = start, purpose: 'login' | 'password_reset' = 'login') =>
    checkCode(database.db, { userId, purpose, code }, { secrets, now })

  it('accepts the right code once', async () => {
    const userId = await newUser()
    const { code, expiresAt } = await issue(userId)
    expect(code).toMatch(/^\d{6}$/)
    expect(expiresAt.getTime() - start.getTime()).toBe(CODE_LIFETIME_MS)

    expect(await check(userId, code)).toEqual({ ok: true, channel: 'email' })
    expect(await check(userId, code)).toEqual({ ok: false, reason: 'none' })
  })

  it('stores only a signature, never the code', async () => {
    const userId = await newUser()
    const { code } = await issue(userId)
    const { rows } = await database.pool.query(`select code_hash from otp_codes where user_id = $1`, [userId])
    expect(rows[0].code_hash).not.toContain(code)
    expect(rows[0].code_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses a wrong code and lets the right one through afterwards', async () => {
    const userId = await newUser()
    const { code } = await issue(userId)
    const wrong = code === '000000' ? '000001' : '000000'
    expect(await check(userId, wrong)).toEqual({ ok: false, reason: 'wrong' })
    expect((await check(userId, ` ${code} `)).ok).toBe(true)
  })

  it('invalidates the code at the sixth attempt, even when it is right', async () => {
    const userId = await newUser()
    const { code } = await issue(userId)
    const wrong = code === '000000' ? '000001' : '000000'
    for (let attempt = 0; attempt < 5; attempt++) expect(await check(userId, wrong)).toEqual({ ok: false, reason: 'wrong' })
    expect(await check(userId, code)).toEqual({ ok: false, reason: 'exhausted' })
    expect(await check(userId, code)).toEqual({ ok: false, reason: 'exhausted' })
  })

  it('counts parallel guesses, so they cannot exceed the attempts', async () => {
    const userId = await newUser()
    const { code } = await issue(userId)
    const wrong = code === '000000' ? '000001' : '000000'
    const results = await Promise.all(Array.from({ length: 12 }, () => check(userId, wrong)))
    expect(results.filter((result) => !result.ok && result.reason === 'wrong')).toHaveLength(5)
    expect(results.filter((result) => !result.ok && result.reason === 'exhausted')).toHaveLength(7)
  })

  it('lets a right code win only once when used in parallel', async () => {
    const userId = await newUser()
    const { code } = await issue(userId)
    const results = await Promise.all(Array.from({ length: 4 }, () => check(userId, code)))
    expect(results.filter((result) => result.ok)).toHaveLength(1)
  })

  it('expires after ten minutes', async () => {
    const userId = await newUser()
    const { code } = await issue(userId)
    expect(await check(userId, code, new Date(start.getTime() + CODE_LIFETIME_MS))).toEqual({ ok: false, reason: 'expired' })
  })

  it('replaces the earlier code when a new one is issued', async () => {
    const userId = await newUser()
    const first = await issue(userId)
    const later = new Date(start.getTime() + RESEND_COOLDOWN_MS)
    const second = await issue(userId, later)
    if (first.code !== second.code) expect(await check(userId, first.code, later)).toEqual({ ok: false, reason: 'wrong' })
    expect((await check(userId, second.code, later)).ok).toBe(true)
  })

  it('does not accept a code for another purpose or another user', async () => {
    const userId = await newUser()
    const other = await newUser()
    const { code } = await issue(userId)
    expect(await check(userId, code, start, 'password_reset')).toEqual({ ok: false, reason: 'none' })
    expect(await check(other, code)).toEqual({ ok: false, reason: 'none' })
  })

  it('verifies with an old secret after the signing secret rotated', async () => {
    const userId = await newUser()
    const { code } = await issueCode(database.db, { userId, channel: 'sms', purpose: 'login' }, { secrets: [secrets[1]!], now: start })
    expect(await check(userId, code)).toEqual({ ok: true, channel: 'sms' })
  })

  it('asks to wait before another code is sent', async () => {
    const userId = await newUser()
    await issue(userId)
    const error = await issue(userId, new Date(start.getTime() + 20_000)).catch((caught) => caught)
    expect(error).toBeInstanceOf(CodeLimitError)
    expect(error).toMatchObject({ reason: 'cooldown', retryAfterSeconds: 40 })
  })

  it('allows five codes per hour and then says when to try again', async () => {
    const userId = await newUser()
    for (let index = 0; index < MAX_CODES_PER_HOUR; index++) await issue(userId, new Date(start.getTime() + minutes(index * 2)))
    const error = await issue(userId, new Date(start.getTime() + minutes(10))).catch((caught) => caught)
    expect(error).toMatchObject({ reason: 'too_many', retryAfterSeconds: 50 * 60 })
    expect((await issue(userId, new Date(start.getTime() + minutes(61)))).code).toMatch(/^\d{6}$/)
  })

  it('limits each purpose on its own', async () => {
    const userId = await newUser()
    await issue(userId)
    expect((await issue(userId, start, 'password_reset')).code).toMatch(/^\d{6}$/)
  })

  it('confirms the e-mail once and keeps the first time', async () => {
    const userId = await newUser()
    await markEmailVerified(database.db, userId, start)
    await markEmailVerified(database.db, userId, new Date(start.getTime() + minutes(5)))
    const { rows } = await database.pool.query(`select email_verified_at from users where id = $1`, [userId])
    expect(rows[0].email_verified_at).toEqual(start)
  })

  it('deletes codes that are long expired', async () => {
    const userId = await newUser()
    await issue(userId)
    expect(await deleteOldCodes(database.db, new Date(start.getTime() + minutes(30)))).toBe(0)
    expect(await deleteOldCodes(database.db, new Date(start.getTime() + minutes(75)))).toBeGreaterThanOrEqual(1)
  })
})
