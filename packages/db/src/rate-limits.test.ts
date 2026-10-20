import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blockedFor, clear, clearPrefix, consume, count, deleteOldRateLimits, type Rule } from './rate-limits.js'
import { createTestDatabase, hasDatabase } from './test/test-database.js'

const start = new Date('2030-01-01T10:00:00Z')
const after = (seconds: number) => new Date(start.getTime() + seconds * 1000)

describe.skipIf(!hasDatabase)('rate limits', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>
  let counter = 0

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  afterAll(async () => {
    await database?.drop()
  })

  const rule = (max = 3, windowSeconds = 900): Rule => ({ key: `test:${++counter}`, max, windowSeconds })

  it('allows what has not happened yet', async () => {
    expect(await blockedFor(database.db, [rule()], start)).toBe(0)
    expect(await blockedFor(database.db, [], start)).toBe(0)
  })

  it('blocks once the counter has reached the maximum, for the rest of the window', async () => {
    const r = rule(3, 900)
    await count(database.db, [r], start)
    await count(database.db, [r], after(10))
    expect(await blockedFor(database.db, [r], after(20))).toBe(0)

    await count(database.db, [r], after(60))
    expect(await blockedFor(database.db, [r], after(60))).toBe(840)
    expect(await blockedFor(database.db, [r], after(899))).toBe(1)
  })

  it('starts a new window when the old one has run out', async () => {
    const r = rule(2, 600)
    await count(database.db, [r, r], start)
    expect(await blockedFor(database.db, [r], after(1))).toBeGreaterThan(0)
    expect(await blockedFor(database.db, [r], after(600))).toBe(0)

    await count(database.db, [r], after(600))
    expect(await blockedFor(database.db, [r], after(601))).toBe(0)
    await count(database.db, [r], after(602))
    expect(await blockedFor(database.db, [r], after(603))).toBe(597)
  })

  it('counts parallel events exactly', async () => {
    const r = rule(100, 900)
    await Promise.all(Array.from({ length: 20 }, () => count(database.db, [r], start)))
    const { rows } = await database.pool.query(`select hits from rate_limits where key = $1`, [r.key])
    expect(rows[0].hits).toBe(20)
  })

  it('tells the longest wait when several rules block', async () => {
    const short = rule(1, 60)
    const long = rule(1, 3600)
    await count(database.db, [short, long], start)
    expect(await blockedFor(database.db, [short], after(10))).toBe(50)
    expect(await blockedFor(database.db, [short, long], after(10))).toBe(3590)
  })

  it('counts and checks in one step: `max` events are allowed, the next one waits', async () => {
    const r = rule(2, 900)
    expect(await consume(database.db, r, start)).toBe(0)
    expect(await consume(database.db, r, after(1))).toBe(0)
    expect(await consume(database.db, r, after(2))).toBe(898)
    expect(await consume(database.db, r, after(3))).toBe(897)
  })

  it('keeps counters apart by key', async () => {
    const a = rule(1)
    const b = rule(1)
    await count(database.db, [a], start)
    expect(await blockedFor(database.db, [a], start)).toBeGreaterThan(0)
    expect(await blockedFor(database.db, [b], start)).toBe(0)
  })

  it('forgets counters by key or by prefix', async () => {
    const a = { key: 'wipe:one:a', max: 1, windowSeconds: 900 }
    const b = { key: 'wipe:one:b', max: 1, windowSeconds: 900 }
    const c = { key: 'wipe:two:c', max: 1, windowSeconds: 900 }
    await count(database.db, [a, b, c], start)

    await clear(database.db, [a.key])
    expect(await blockedFor(database.db, [a], start)).toBe(0)
    expect(await blockedFor(database.db, [b], start)).toBeGreaterThan(0)

    await clearPrefix(database.db, 'wipe:one:')
    expect(await blockedFor(database.db, [b], start)).toBe(0)
    expect(await blockedFor(database.db, [c], start)).toBeGreaterThan(0)
  })

  it('does not take % or _ in a prefix for a wildcard', async () => {
    const a = { key: 'wild:xyz', max: 1, windowSeconds: 900 }
    await count(database.db, [a], start)
    await clearPrefix(database.db, 'wild:%')
    await clearPrefix(database.db, 'wild:_yz')
    expect(await blockedFor(database.db, [a], start)).toBeGreaterThan(0)
  })

  it('removes counters that ended a day ago', async () => {
    const old = rule(1, 60)
    const recent = rule(1, 60)
    await count(database.db, [old], start)
    await count(database.db, [recent], after(23 * 3600))
    await deleteOldRateLimits(database.db, after(25 * 3600))
    const { rows } = await database.pool.query(`select key from rate_limits where key = any($1)`, [[old.key, recent.key]])
    expect(rows.map((row) => row.key)).toEqual([recent.key])
  })
})
