import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'

describe.skipIf(!hasDatabase)('admin API: audit events', () => {
  let h: AdminHarness
  let user: { id: string; email: string }
  let clientSecret: string

  beforeAll(async () => {
    h = await createAdminHarness()
    user = (await h.api('POST', '/users', { body: { email: 'audited@example.com', firstName: 'Au', lastName: 'Dit' } })).json()
    await h.api('PATCH', `/users/${user.id}`, { body: { firstName: 'Audrey' } })
    await h.api('POST', `/users/${user.id}/lock`)
    await h.api('POST', '/claim-types', { body: { key: 'audit_tag' } })
    clientSecret = (
      await h.api('POST', '/clients', { body: { clientId: 'audit-app', name: 'Audit app', type: 'confidential', redirectUris: ['https://a.example.com/cb'] } })
    ).json().clientSecret
    clientSecret = (await h.api('POST', '/clients/audit-app/rotate-secret')).json().clientSecret
  })

  afterAll(async () => {
    await h?.close()
  })

  const list = async (query = '', token = h.adminToken) => {
    const response = await h.api('GET', `/audit-events${query ? `?${query}` : ''}`, { token })
    expect(response.statusCode, response.body).toBe(200)
    return response.json() as { items: { id: string; action: string; actorId: string; targetId: string; details: Record<string, unknown>; ip: string; userAgent: string; createdAt: string }[]; nextCursor?: string }
  }

  it('acceptance: a script with an admin client creates a user, sets claims, locks and unlocks, and every step is in the log', async () => {
    const created = (await h.api('POST', '/users', { body: { email: 'story@example.com', firstName: 'Sto', lastName: 'Ry' } })).json()
    await h.api('PUT', `/users/${created.id}/claims/partner_no`, { body: { values: ['00892', '00893'] } })
    await h.api('POST', `/users/${created.id}/lock`)
    await h.api('POST', `/users/${created.id}/unlock`)

    const { items } = await list(`targetType=user&targetId=${created.id}`)

    expect(items.map((event) => event.action)).toEqual(['user.unlock', 'user.lock', 'user.claims.set', 'user.create'])
    expect(items.every((event) => event.actorId === 'demo-admin')).toBe(true)
    expect(items[2]!.details.changes).toEqual({ partner_no: { from: [], to: ['00892', '00893'] } })
  })

  it('shows who did what, from where and when', async () => {
    const { items } = await list(`action=user.create&targetId=${user.id}`)

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      actorType: 'client',
      actorId: 'demo-admin',
      action: 'user.create',
      targetType: 'user',
      targetId: user.id,
      userAgent: 'admin-test/1.0',
    })
    expect(items[0]!.details).toMatchObject({ email: 'audited@example.com' })
    expect(items[0]!.ip).toBeTruthy()
    expect(new Date(items[0]!.createdAt).getTime()).toBeGreaterThan(Date.now() - 60_000)
  })

  it('lists the history of one user, newest first', async () => {
    const { items } = await list(`targetType=user&targetId=${user.id}`)

    expect(items.map((event) => event.action)).toEqual(['user.lock', 'user.update', 'user.create'])
    expect(items[1]!.details.changes).toEqual({ firstName: { from: 'Au', to: 'Audrey' } })
  })

  it('filters by action prefix, by actor and by time', async () => {
    expect((await list('action=user.*')).items.every((event) => event.action.startsWith('user.'))).toBe(true)
    expect((await list('action=client.*')).items.map((event) => event.action).sort()).toEqual(['client.create', 'client.rotate_secret'])
    expect((await list('actorId=nobody')).items).toEqual([])

    const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
    const inAnHour = new Date(Date.now() + 3_600_000).toISOString()
    expect((await list(`from=${hourAgo}&to=${inAnHour}&action=user.create`)).items.length).toBeGreaterThan(0)
    expect((await list(`from=${inAnHour}`)).items).toEqual([])
    expect((await list(`to=${hourAgo}`)).items).toEqual([])
  })

  it('pages through every event once, newest first', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await list(`limit=3${cursor ? `&cursor=${cursor}` : ''}`)
      expect(page.items.length).toBeLessThanOrEqual(3)
      seen.push(...page.items.map((event) => event.id))
      cursor = page.nextCursor
    } while (cursor)

    expect(seen).toHaveLength(await h.count('audit_events'))
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toEqual([...seen].sort().reverse())
  })

  it('keeps every secret out of the log', async () => {
    const everything = JSON.stringify((await list('limit=200')).items)

    expect(everything).not.toContain(clientSecret)
    expect(everything).not.toMatch(/argon2/i)
    expect(everything).not.toMatch(/password_?hash|secret_?hash/i)
  })

  it('does not record that someone read it', async () => {
    const before = await h.count('audit_events')

    await list()
    await list('action=user.*')

    expect(await h.count('audit_events')).toBe(before)
  })

  it('needs the admin scope', async () => {
    expect((await h.api('GET', '/audit-events', { token: h.directoryToken })).statusCode).toBe(403)
    expect((await h.api('GET', '/audit-events', { token: null })).statusCode).toBe(401)
  })

  it.each(['limit=0', 'limit=201', 'cursor=nope', 'from=yesterday', 'actorType=robot', 'actorId='])('rejects %s', async (query) => {
    expect((await h.api('GET', `/audit-events?${query}`)).statusCode).toBe(400)
  })
})
