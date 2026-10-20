import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deleteOldLoginEvents, recordAuditEvent } from './audit.js'
import { createTestDatabase, hasDatabase } from './test/test-database.js'

const day = 24 * 60 * 60 * 1000

describe.skipIf(!hasDatabase)('keeping the audit log in shape', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>
  const now = new Date('2030-06-01T12:00:00Z')

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  afterAll(async () => {
    await database?.drop()
  })

  const record = async (action: string, daysAgo: number) => {
    await recordAuditEvent(database.db, { actor: { type: 'user', id: 'u1' }, action, details: { daysAgo } })
    await database.pool.query(`update audit_events set created_at = $1 where id = (select id from audit_events order by id desc limit 1)`, [
      new Date(now.getTime() - daysAgo * day),
    ])
  }
  const actions = async () => (await database.pool.query(`select action, details->>'daysAgo' as days from audit_events order by action, days`)).rows

  it('deletes sign-in events that are older than the given days, and nothing else', async () => {
    await record('login.password_failed', 200)
    await record('login.succeeded', 181)
    await record('login.code_failed', 179)
    await record('login.blocked', 1)
    await record('user.create', 400)
    await record('user.lock', 200)
    await record('client.delete', 1000)

    expect(await deleteOldLoginEvents(database.db, 180, now)).toBe(2)

    expect((await actions()).map((row) => `${row.action}:${row.days}`)).toEqual([
      'client.delete:1000',
      'login.blocked:1',
      'login.code_failed:179',
      'user.create:400',
      'user.lock:200',
    ])
  })

  it('does not take other actions for a sign-in event because of their name', async () => {
    await record('loginish.thing', 999)
    await deleteOldLoginEvents(database.db, 1, now)
    expect((await actions()).map((row) => row.action)).toContain('loginish.thing')
  })

  it('has nothing to delete when everything is recent', async () => {
    expect(await deleteOldLoginEvents(database.db, 365, now)).toBe(0)
  })
})
