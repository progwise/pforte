import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { recordAuditEvent } from '../audit.js'
import { createTestDatabase, hasDatabase } from '../test/test-database.js'
import { listAuditEvents } from './audit.js'

describe.skipIf(!hasDatabase)('listing audit events', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>

  beforeAll(async () => {
    database = await createTestDatabase()
    const record = (actorId: string, action: string, target: [string, string], at?: string) =>
      recordAuditEvent(database.db, { actor: { type: 'client', id: actorId }, action, target: { type: target[0], id: target[1] }, details: { n: action } })
        .then(() => (at ? database.pool.query(`update audit_events set created_at = $1 where id = (select id from audit_events order by id desc limit 1)`, [at]) : undefined))

    await record('import', 'user.create', ['user', 'u1'], '2026-01-01T10:00:00Z')
    await record('import', 'user.update', ['user', 'u1'], '2026-01-02T10:00:00Z')
    await record('ops', 'user.lock', ['user', 'u2'], '2026-01-03T10:00:00Z')
    await record('ops', 'client.create', ['client', 'shop'], '2026-01-04T10:00:00Z')
    await record('ops', 'claim_type.delete', ['claim_type', 'team'], '2026-01-05T10:00:00Z')
    await recordAuditEvent(database.db, { actor: { type: 'system' }, action: 'user.login', target: { type: 'user', id: 'u1' } })
  })

  afterAll(async () => {
    await database?.drop()
  })

  const actions = async (options: Partial<Parameters<typeof listAuditEvents>[1]> = {}) =>
    (await listAuditEvents(database.db, { limit: 50, ...options })).items.map((event) => event.action)

  it('lists newest first', async () => {
    expect(await actions()).toEqual(['user.login', 'claim_type.delete', 'client.create', 'user.lock', 'user.update', 'user.create'])
  })

  it('filters by actor, target and exact action', async () => {
    expect(await actions({ actorId: 'ops' })).toEqual(['claim_type.delete', 'client.create', 'user.lock'])
    expect(await actions({ actorType: 'system' })).toEqual(['user.login'])
    expect(await actions({ targetType: 'user', targetId: 'u1' })).toEqual(['user.login', 'user.update', 'user.create'])
    expect(await actions({ action: 'user.lock' })).toEqual(['user.lock'])
  })

  it('filters by action prefix, and the underscore of a claim type is not a wildcard', async () => {
    expect(await actions({ action: 'user.*' })).toEqual(['user.login', 'user.lock', 'user.update', 'user.create'])
    expect(await actions({ action: 'claim_type.*' })).toEqual(['claim_type.delete'])
    // `_` is literal: "claimXtype." would match if it were a wildcard.
    expect(await actions({ action: 'claim%*' })).toEqual([])
  })

  it('filters by time: from is inclusive, to is exclusive', async () => {
    expect(await actions({ from: new Date('2026-01-03T10:00:00Z'), to: new Date('2026-01-05T10:00:00Z') })).toEqual(['client.create', 'user.lock'])
  })

  it('combines filters', async () => {
    expect(await actions({ actorId: 'import', action: 'user.update' })).toEqual(['user.update'])
    expect(await actions({ actorId: 'import', action: 'user.lock' })).toEqual([])
  })

  it('pages through everything once, newest first, without repeating', async () => {
    const seen: string[] = []
    let before: string | undefined
    do {
      const page = await listAuditEvents(database.db, { limit: 2, before })
      seen.push(...page.items.map((event) => event.id))
      before = page.nextCursor
    } while (before)

    expect(seen).toHaveLength(6)
    expect(new Set(seen).size).toBe(6)
    expect(seen).toEqual([...seen].sort().reverse())
  })
})
