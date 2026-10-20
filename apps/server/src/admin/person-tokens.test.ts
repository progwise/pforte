import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'

describe.skipIf(!hasDatabase)('admin API: a person signed in to the administration UI', () => {
  let h: AdminHarness
  let token: string

  beforeAll(async () => {
    h = await createAdminHarness()
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(async () => {
    await h.database.pool.query('delete from rate_limits')
    await h.database.pool.query(`update users set status = 'active', is_admin = (email = 'admin@example.com') where email like '%@example.com' and password_hash is not null`)
    token = await h.personToken('admin@example.com')
  })

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, as: string | null = token, body?: unknown) => h.api(method, url, { token: as, body })
  const userId = async (email: string) => (await h.database.pool.query(`select id from users where email = $1`, [email])).rows[0].id as string

  it('may use the API with the token the UI got for them', async () => {
    const response = await call('GET', '/users?limit=1')
    expect(response.statusCode).toBe(200)
    expect(response.json().items).toHaveLength(1)
  })

  it('is told who they are, as a machine is told its client and scopes', async () => {
    expect((await call('GET', '/whoami')).json()).toEqual({
      kind: 'user',
      clientId: 'pforte-admin-ui',
      scopes: ['admin'],
      user: { id: await userId('admin@example.com'), email: 'admin@example.com', firstName: expect.any(String), lastName: expect.any(String), language: expect.any(String) },
    })
    expect((await call('GET', '/whoami', h.directoryToken)).json()).toEqual({ kind: 'client', clientId: 'demo-import', scopes: ['directory'], user: null })
  })

  it('has everything the admin scope allows, such as the audit log and clients', async () => {
    expect((await call('GET', '/audit-events?limit=1')).statusCode).toBe(200)
    expect((await call('GET', '/clients')).statusCode).toBe(200)
  })

  it('is recorded under their own name, with their address and browser', async () => {
    const target = await userId('ben.keller@example.com')
    const changed = await call('PATCH', `/users/${target}`, token, { firstName: 'Benedikt' })
    expect(changed.statusCode).toBe(200)

    const [event] = await h.audit('user.update', target)
    expect(event).toMatchObject({ actor_type: 'user', actor_id: await userId('admin@example.com') })
    expect(event.user_agent).toBeTruthy()
    await call('PATCH', `/users/${target}`, token, { firstName: 'Ben' })
  })

  it('is not accepted any more once the person is locked, or no longer an administrator, without waiting for the token to expire', async () => {
    const id = await userId('admin@example.com')
    await h.database.pool.query(`update users set is_admin = false where id = $1`, [id])
    expect((await call('GET', '/users?limit=1')).statusCode).toBe(401)

    await h.database.pool.query(`update users set is_admin = true, status = 'locked' where id = $1`, [id])
    expect((await call('GET', '/users?limit=1')).statusCode).toBe(401)

    await h.database.pool.query(`update users set status = 'active' where id = $1`, [id])
    expect((await call('GET', '/users?limit=1')).statusCode).toBe(200)
  })

  it('is not accepted for somebody who is not an administrator, although the UI would sign them in', async () => {
    const ordinary = await h.personToken('ben.keller@example.com')
    expect((await call('GET', '/users?limit=1', ordinary)).statusCode).toBe(401)
  })

  it('is not accepted from any other application, even for an administrator', async () => {
    const other = await h.personToken('admin@example.com', { clientId: 'demo-web', redirectUri: 'http://localhost:3400/callback' })
    expect((await call('GET', '/users?limit=1', other)).statusCode).toBe(401)
  })

  it('cannot lock, deactivate, delete or demote themselves', async () => {
    const id = await userId('admin@example.com')
    for (const [method, path, body] of [
      ['POST', `/users/${id}/lock`, undefined],
      ['POST', `/users/${id}/deactivate`, undefined],
      ['DELETE', `/users/${id}`, undefined],
      ['PATCH', `/users/${id}`, { isAdmin: false }],
    ] as const) {
      const response = await call(method, path, token, body)
      expect(response.statusCode, `${method} ${path}`).toBe(409)
      expect(response.json().detail).toMatch(/yourself/)
    }
    expect((await call('GET', '/users?limit=1')).statusCode).toBe(200)
  })

  it('cannot remove the last active administrator, not even a machine with the admin scope', async () => {
    await h.database.pool.query(`update users set is_admin = false where email <> 'admin@example.com'`)
    const id = await userId('admin@example.com')
    for (const [method, path, body] of [
      ['POST', `/users/${id}/lock`, undefined],
      ['POST', `/users/${id}/deactivate`, undefined],
      ['DELETE', `/users/${id}`, undefined],
      ['PATCH', `/users/${id}`, { isAdmin: false }],
    ] as const) {
      const response = await call(method, path, h.adminToken, body)
      expect(response.statusCode, `${method} ${path}`).toBe(409)
      expect(response.json().detail).toMatch(/last active administrator/)
    }
    expect((await h.database.pool.query(`select is_admin, status from users where id = $1`, [id])).rows[0]).toEqual({ is_admin: true, status: 'active' })
  })

  it('may remove another administrator, when one remains', async () => {
    const other = await userId('ben.keller@example.com')
    await h.database.pool.query(`update users set is_admin = true where id = $1`, [other])
    expect((await call('PATCH', `/users/${other}`, token, { isAdmin: false })).statusCode).toBe(200)
  })

  it('still counts failed authentication: a made-up token is refused like any other', async () => {
    expect((await call('GET', '/users?limit=1', 'not-a-token')).statusCode).toBe(401)
    expect((await call('GET', '/users?limit=1', null)).statusCode).toBe(401)
  })

  describe('the built-in client', () => {
    it('is listed as such and cannot be changed, rotated or deleted', async () => {
      const list = (await call('GET', '/clients')).json().items as { clientId: string; system: boolean }[]
      expect(list.find((client) => client.clientId === 'pforte-admin-ui')).toMatchObject({ system: true })
      expect(list.filter((client) => client.system).map((client) => client.clientId)).toEqual(['pforte-admin-ui'])

      for (const [method, path, body] of [
        ['PATCH', '/clients/pforte-admin-ui', { name: 'Mine' }],
        ['POST', '/clients/pforte-admin-ui/rotate-secret', undefined],
        ['DELETE', '/clients/pforte-admin-ui', undefined],
      ] as const) {
        const response = await call(method, path, token, body)
        expect(response.statusCode, `${method} ${path}`).toBe(409)
        expect(response.json().detail).toMatch(/built-in client/)
      }
    })

    it('cannot be created or replaced under its name through the API', async () => {
      const response = await call('POST', '/clients', h.adminToken, {
        clientId: 'pforte-admin-ui',
        name: 'Impostor',
        type: 'public',
        redirectUris: ['https://evil.example/cb'],
        postLogoutRedirectUris: [],
        allowedGrants: ['authorization_code'],
        scopes: ['openid'],
      })
      expect(response.statusCode).toBe(409)
      expect((await h.database.pool.query(`select redirect_uris from clients where client_id = 'pforte-admin-ui'`)).rows[0].redirect_uris).toEqual(['https://localhost:3300/manage/callback'])
    })
  })
})
