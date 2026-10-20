import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase, hasDatabase } from '../test/test-database.js'
import { ensureAdministrator } from './bootstrap.js'

describe.skipIf(!hasDatabase)('the first administrator', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>
  const delivered: { email: string; token: string }[] = []
  const deliver = async (user: { email: string }, activation: { token: string }) => void delivered.push({ email: user.email, token: activation.token })

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  afterAll(async () => {
    await database?.drop()
  })

  beforeEach(async () => {
    delivered.length = 0
    await database.pool.query('delete from users')
    await database.pool.query('delete from audit_events')
  })

  it('creates an administrator when there is none, and sends the activation link', async () => {
    const result = await ensureAdministrator(database.db, ' Boss@Example.com ', deliver)

    expect(result.outcome).toBe('created')
    const { rows } = await database.pool.query(`select email, is_admin, status, password_hash, activation_token_hash from users`)
    expect(rows).toEqual([{ email: 'boss@example.com', is_admin: true, status: 'created', password_hash: null, activation_token_hash: expect.any(String) }])
    expect(delivered).toEqual([{ email: 'boss@example.com', token: expect.stringMatching(/^[\w-]{43}$/) }])
  })

  it('records that pforte did it, and keeps the token out of the audit log', async () => {
    await ensureAdministrator(database.db, 'boss@example.com', deliver)
    const { rows } = await database.pool.query(`select actor_type, action, details from audit_events order by created_at, id`)
    expect(rows.map((row) => row.action)).toEqual(['user.create', 'user.activate'])
    expect(rows.every((row) => row.actor_type === 'system')).toBe(true)
    expect(JSON.stringify(rows)).not.toContain(delivered[0]!.token)
  })

  it('does nothing when an administrator exists, whatever their status, so it can run at every start', async () => {
    await database.pool.query(`insert into users (email, first_name, last_name, is_admin, status) values ('old@example.com', 'O', 'A', true, 'locked')`)
    expect(await ensureAdministrator(database.db, 'boss@example.com', deliver)).toEqual({ outcome: 'exists' })
    expect(delivered).toEqual([])
    expect((await database.pool.query('select count(*) from users')).rows[0].count).toBe('1')
  })

  it('does nothing the second time', async () => {
    await ensureAdministrator(database.db, 'boss@example.com', deliver)
    expect(await ensureAdministrator(database.db, 'boss@example.com', deliver)).toEqual({ outcome: 'exists' })
    expect(delivered).toHaveLength(1)
  })

  it('makes an existing user an administrator, and sends the link only if they still have to choose a password', async () => {
    await database.pool.query(`insert into users (email, first_name, last_name, status) values ('imported@example.com', 'I', 'M', 'created')`)
    const result = await ensureAdministrator(database.db, 'imported@example.com', deliver)
    expect(result.outcome).toBe('promoted')
    expect(delivered).toHaveLength(1)
    expect((await database.pool.query(`select is_admin from users`)).rows[0].is_admin).toBe(true)
  })

  it('does not send a link to an existing user who can sign in already', async () => {
    await database.pool.query(`insert into users (email, first_name, last_name, status, password_hash) values ('active@example.com', 'A', 'C', 'active', 'hash')`)
    const result = await ensureAdministrator(database.db, 'active@example.com', deliver)
    expect(result.outcome).toBe('promoted')
    expect(delivered).toEqual([])
    expect((await database.pool.query(`select is_admin, status from users`)).rows[0]).toEqual({ is_admin: true, status: 'active' })
  })

  it('changes nothing when the link cannot be sent, so the next start tries again', async () => {
    const failing = async () => {
      throw new Error('mail server is down')
    }
    await expect(ensureAdministrator(database.db, 'boss@example.com', failing)).rejects.toThrow('mail server is down')
    expect((await database.pool.query('select count(*) from users')).rows[0].count).toBe('0')
    expect((await database.pool.query('select count(*) from audit_events')).rows[0].count).toBe('0')

    expect((await ensureAdministrator(database.db, 'boss@example.com', deliver)).outcome).toBe('created')
  })

  it('creates one administrator and sends one link when several instances start at the same moment', async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => ensureAdministrator(database.db, 'boss@example.com', deliver)))
    expect(results.filter((result) => result.outcome === 'created')).toHaveLength(1)
    expect(results.filter((result) => result.outcome === 'exists')).toHaveLength(3)
    expect(delivered).toHaveLength(1)
  })
})
