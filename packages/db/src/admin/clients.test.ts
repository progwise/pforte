import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, hasDatabase } from '../test/test-database.js'
import {
  type ClientConfig,
  createClient,
  deleteClient,
  ensureSystemClient,
  getClient,
  listClients,
  rotateClientSecret,
  updateClient,
  validateClientConfig,
} from './clients.js'
import { AdminError } from './errors.js'

const context = { actor: { type: 'client' as const, id: 'ops' }, ip: '203.0.113.7', userAgent: 'vitest' }

const application: ClientConfig = {
  name: 'Shop',
  type: 'confidential',
  clientUri: null,
  redirectUris: ['https://shop.example.com/callback'],
  postLogoutRedirectUris: ['https://shop.example.com/'],
  backchannelLogoutUri: null,
  backchannelLogoutSessionRequired: false,
  allowedGrants: ['authorization_code', 'refresh_token'],
  scopes: ['openid', 'profile'],
  pkceRequired: true,
}
const machine: ClientConfig = {
  name: 'Import job',
  type: 'confidential',
  clientUri: null,
  redirectUris: [],
  postLogoutRedirectUris: [],
  backchannelLogoutUri: null,
  backchannelLogoutSessionRequired: false,
  allowedGrants: ['client_credentials'],
  scopes: ['directory'],
  pkceRequired: true,
}

const pathsOf = (config: ClientConfig) => validateClientConfig(config).map((problem) => problem.path)

describe('client rules', () => {
  it('accepts an application and a machine client', () => {
    expect(validateClientConfig(application)).toEqual([])
    expect(validateClientConfig(machine)).toEqual([])
    expect(validateClientConfig({ ...application, type: 'public', redirectUris: ['http://localhost:3400/callback'] })).toEqual([])
  })

  it.each([
    ['an http redirect URI that is not localhost', { redirectUris: ['http://shop.example.com/cb'] }, '/redirectUris/0'],
    ['a wildcard in a redirect URI', { redirectUris: ['https://*.example.com/cb'] }, '/redirectUris/0'],
    ['a fragment in a redirect URI', { redirectUris: ['https://shop.example.com/cb#x'] }, '/redirectUris/0'],
    ['a redirect URI that is not a URL', { redirectUris: ['nonsense'] }, '/redirectUris/0'],
    ['a post-logout URI with plain http', { postLogoutRedirectUris: ['http://shop.example.com/'] }, '/postLogoutRedirectUris/0'],
    ['a back-channel logout URI with plain http', { backchannelLogoutUri: 'http://erp.example.com/logout' }, '/backchannelLogoutUri'],
    ['no redirect URI', { redirectUris: [] }, '/redirectUris'],
    ['no authorization_code grant', { allowedGrants: ['refresh_token'] }, '/allowedGrants'],
    ['a grant that applications do not get', { allowedGrants: ['authorization_code', 'implicit'] }, '/allowedGrants'],
    ['an admin scope on an application', { scopes: ['openid', 'admin'] }, '/scopes'],
    ['no openid scope on an application', { scopes: ['profile'] }, '/scopes'],
    ['PKCE switched off on a public client', { type: 'public' as const, pkceRequired: false }, '/pkceRequired'],
  ])('refuses %s', (_name, change, path) => {
    expect(pathsOf({ ...application, ...change })).toContain(path)
  })

  it.each([
    ['a public machine client', { type: 'public' as const }, '/type'],
    ['an OpenID scope on a machine client', { scopes: ['openid'] }, '/scopes'],
    ['no scope at all', { scopes: [] }, '/scopes'],
    ['a machine client mixing in another grant', { allowedGrants: ['client_credentials', 'authorization_code'] }, '/allowedGrants'],
    ['a redirect URI on a machine client', { redirectUris: ['https://x.example.com/cb'] }, '/redirectUris'],
  ])('refuses %s', (_name, change, path) => {
    expect(pathsOf({ ...machine, ...change })).toContain(path)
  })

  it('reports every problem, not only the first', () => {
    const paths = pathsOf({ ...application, redirectUris: ['http://a.example.com', 'https://*.example.com'], scopes: ['admin'] })

    expect(paths).toEqual(expect.arrayContaining(['/redirectUris/0', '/redirectUris/1', '/scopes']))
  })
})

describe.skipIf(!hasDatabase)('client operations', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>

  beforeAll(async () => {
    database = await createTestDatabase()
    await database.pool.query(`insert into claim_types (key) values ('partner_no')`)
  })

  afterAll(async () => {
    await database?.drop()
  })

  const create = (clientId: string, config: ClientConfig, secretHash: string | undefined = config.type === 'confidential' ? 'hash' : undefined) =>
    database.db.transaction((tx) => createClient(tx, context, { clientId, secretHash, ...config }))
  const events = async (action: string, clientId: string) =>
    (await database.pool.query(`select * from audit_events where action = $1 and target_id = $2 order by created_at`, [action, clientId])).rows
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise
    } catch (error) {
      return error as AdminError
    }
    throw new Error('expected an AdminError')
  }

  it('creates a client and records it without any secret', async () => {
    const created = await create('shop', application, 'argon2-hash-value')

    expect(created).toMatchObject({ clientId: 'shop', type: 'confidential', scopes: ['openid', 'profile'], pkceRequired: true })
    const [event] = await events('client.create', 'shop')
    expect(event).toMatchObject({ actor_id: 'ops', target_type: 'client' })
    expect(JSON.stringify(event)).not.toContain('argon2-hash-value')
  })

  it('refuses an invalid client with every problem and writes nothing', async () => {
    const error = await failure(create('broken', { ...application, redirectUris: ['http://x.example.com'], scopes: ['admin'] }))

    expect(error.kind).toBe('invalid')
    expect(error.problems.map((problem) => problem.path)).toEqual(expect.arrayContaining(['/redirectUris/0', '/scopes']))
    expect(await getClient(database.db, 'broken')).toBeUndefined()
    expect(await events('client.create', 'broken')).toHaveLength(0)
  })

  it('changes the given fields, records the difference and says nothing changed otherwise', async () => {
    const client = (await getClient(database.db, 'shop'))!

    const changed = await database.db.transaction((tx) =>
      updateClient(tx, context, client, { redirectUris: ['https://shop.example.com/callback', 'https://shop.example.com/other'] }),
    )
    const same = await database.db.transaction((tx) => updateClient(tx, context, changed.client, { name: 'Shop' }))

    expect(changed.changed).toBe(true)
    expect(same.changed).toBe(false)
    const updates = await events('client.update', 'shop')
    expect(updates).toHaveLength(1)
    expect(updates[0].details.changes.redirectUris.to).toHaveLength(2)
  })

  it('requires the result of a change to be valid', async () => {
    const client = (await getClient(database.db, 'shop'))!

    const error = await failure(database.db.transaction((tx) => updateClient(tx, context, client, { redirectUris: [] })))

    expect(error.kind).toBe('invalid')
    expect((await getClient(database.db, 'shop'))!.redirectUris).toHaveLength(2)
  })

  it('rotates the secret of a confidential client but not of a public one', async () => {
    const confidential = (await getClient(database.db, 'shop'))!
    await database.db.transaction((tx) => rotateClientSecret(tx, context, confidential, 'new-hash'))
    expect((await getClient(database.db, 'shop'))!.secretHash).toBe('new-hash')
    expect(JSON.stringify(await events('client.rotate_secret', 'shop'))).not.toContain('new-hash')

    const publicClient = await create('spa', { ...application, type: 'public' })
    const error = await failure(database.db.transaction((tx) => rotateClientSecret(tx, context, publicClient, 'x')))
    expect(error.kind).toBe('conflict')
  })

  describe('the last admin client', () => {
    it('cannot lose the admin scope or be deleted, while another client holds it', async () => {
      await create('admin-a', { ...machine, scopes: ['admin'] })
      const a = (await getClient(database.db, 'admin-a'))!

      const downgrade = await failure(database.db.transaction((tx) => updateClient(tx, context, a, { scopes: ['directory'] })))
      const removal = await failure(
        database.db.transaction((tx) => deleteClient(tx, { ...context, actor: { type: 'client', id: 'someone-else' } }, a)),
      )

      expect(downgrade.kind).toBe('conflict')
      expect(downgrade.message).toContain('last client with the admin scope')
      expect(removal.kind).toBe('conflict')
      expect(await getClient(database.db, 'admin-a')).toBeDefined()
    })

    it('may be changed or deleted once another client has the scope', async () => {
      await create('admin-b', { ...machine, scopes: ['admin'] })
      const a = (await getClient(database.db, 'admin-a'))!

      const downgraded = await database.db.transaction((tx) => updateClient(tx, context, a, { scopes: ['directory'] }))

      expect(downgraded.client.scopes).toEqual(['directory'])
    })
  })

  describe('deleting', () => {
    it('refuses a client deleting itself', async () => {
      const shop = (await getClient(database.db, 'shop'))!

      const error = await failure(
        database.db.transaction((tx) => deleteClient(tx, { ...context, actor: { type: 'client', id: 'shop' } }, shop)),
      )

      expect(error.message).toContain('cannot delete itself')
    })

    it('removes the client, its assignments and every grant and token issued to it', async () => {
      await database.pool.query(`insert into client_claim_types (client_id, claim_type_key) values ('shop', 'partner_no')`)
      await database.pool.query(`
        insert into oidc_payloads (id, type, payload) values
          ('grant-1', 13, '{"clientId":"shop","accountId":"u1"}'),
          ('token-1', 4, '{"clientId":"shop","accountId":"u1"}'),
          ('other-1', 4, '{"clientId":"spa","accountId":"u1"}')`)
      const shop = (await getClient(database.db, 'shop'))!

      await database.db.transaction((tx) => deleteClient(tx, context, shop))

      expect(await getClient(database.db, 'shop')).toBeUndefined()
      expect((await database.pool.query(`select count(*) from client_claim_types where client_id = 'shop'`)).rows[0].count).toBe('0')
      expect((await database.pool.query(`select id from oidc_payloads where id in ('grant-1', 'token-1', 'other-1')`)).rows).toEqual([{ id: 'other-1' }])
      const [event] = await events('client.delete', 'shop')
      expect(event.details).toMatchObject({ name: 'Shop', tokensAndGrantsRevoked: 2 })
    })
  })
})

describe.skipIf(!hasDatabase)('built-in clients', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>
  const context = { actor: { type: 'client' as const, id: 'ops' }, ip: '203.0.113.7', userAgent: 'vitest' }
  const ui = {
    clientId: 'pforte-admin-ui',
    name: 'Administration',
    redirectUris: ['https://id.example.com/manage/callback'],
    postLogoutRedirectUris: ['https://id.example.com/manage/signed-out'],
    scopes: ['openid', 'profile'],
  }

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  afterAll(async () => {
    await database?.drop()
  })

  it('is created as a public client for the authorization code flow with PKCE, marked as built in', async () => {
    await ensureSystemClient(database.db, ui)
    const client = (await getClient(database.db, 'pforte-admin-ui'))!
    expect(client).toMatchObject({
      type: 'public',
      system: true,
      pkceRequired: true,
      secretHash: null,
      allowedGrants: ['authorization_code'],
      scopes: ['openid', 'profile'],
      redirectUris: ui.redirectUris,
    })
  })

  it('is written again at every start, so changed settings apply and tampering does not survive', async () => {
    await database.pool.query(`update clients set redirect_uris = '{https://evil.example/cb}', scopes = '{openid,offline_access}' where client_id = 'pforte-admin-ui'`)
    await ensureSystemClient(database.db, { ...ui, redirectUris: ['https://id.example.org/manage/callback'] })
    const client = (await getClient(database.db, 'pforte-admin-ui'))!
    expect(client.redirectUris).toEqual(['https://id.example.org/manage/callback'])
    expect(client.scopes).toEqual(['openid', 'profile'])
    expect((await listClients(database.db)).filter((candidate) => candidate.clientId === 'pforte-admin-ui')).toHaveLength(1)
  })

  it('writes no audit event, since it is pforte\'s own setup', async () => {
    const { rows } = await database.pool.query(`select count(*) from audit_events where target_id = 'pforte-admin-ui'`)
    expect(Number(rows[0].count)).toBe(0)
  })

  it('cannot be changed, rotated or deleted through the API', async () => {
    const client = (await getClient(database.db, 'pforte-admin-ui'))!
    const attempts = [
      () => database.db.transaction((tx) => updateClient(tx, context, client, { name: 'Mine' })),
      () => database.db.transaction((tx) => rotateClientSecret(tx, context, client, 'hash')),
      () => database.db.transaction((tx) => deleteClient(tx, context, client)),
    ]
    // one after the other: started together, a failure could arrive before anyone is waiting for it
    for (const attempt of attempts) {
      const error = await attempt().catch((caught) => caught)
      expect(error).toBeInstanceOf(AdminError)
      expect(error).toMatchObject({ kind: 'conflict' })
      expect(error.message).toMatch(/built-in client/)
    }
    expect((await getClient(database.db, 'pforte-admin-ui'))!.name).toBe('Administration')
  })

  it('refuses settings that are not valid for a client', async () => {
    await expect(ensureSystemClient(database.db, { ...ui, redirectUris: ['http://insecure.example/cb'] })).rejects.toMatchObject({ kind: 'invalid' })
    await expect(ensureSystemClient(database.db, { ...ui, scopes: ['admin'] })).rejects.toBeInstanceOf(AdminError)
  })
})
