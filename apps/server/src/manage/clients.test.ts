import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { Browser } from '../test/browser.js'
import { signedInToManage } from '../test/manage-session.js'

describe.skipIf(!hasDatabase)('the administration: clients', () => {
  let h: AdminHarness
  let browser: Browser

  beforeAll(async () => {
    h = await createAdminHarness()
    await h.database.pool.query(`insert into claim_types (key, description) values ('team_code', 'The team'), ('region', 'The region') on conflict do nothing`)
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(async () => {
    await h.database.pool.query('delete from rate_limits')
    await h.database.pool.query('delete from otp_codes')
    await h.database.pool.query(`delete from clients where client_id like 'zz-%'`)
    await h.database.pool.query(
      `update users set first_name = 'Ada', last_name = 'Admin', is_admin = true, status = 'active', language = 'en' where email = 'admin@example.com'`,
    )
    browser = await signedInToManage(h, Browser)
  })

  const get = (url: string) => browser.request('GET', url)
  const post = (url: string, form: Record<string, string | string[]> = {}) => browser.request('POST', url, { form })
  const plain = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '')
  const follow = async (response: { statusCode: number; headers: Record<string, unknown> }) => {
    expect(response.statusCode).toBe(303)
    return get(response.headers.location as string)
  }
  const row = async (clientId: string) => (await h.database.pool.query(`select * from clients where client_id = $1`, [clientId])).rows[0]
  const application = (extra: Record<string, string | string[]> = {}) => ({
    clientId: 'zz-web',
    name: 'Web shop',
    type: 'public',
    redirectUris: 'https://shop.example.com/callback',
    scopes: ['profile', 'email'],
    refresh: 'on',
    ...extra,
  })

  it('is closed to somebody who is not signed in', async () => {
    const response = await new Browser(h.app).request('GET', '/manage/clients')
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/manage/login?next=%2Fmanage%2Fclients')
  })

  describe('the list', () => {
    it('shows every client with its kind and type, and marks the built-in one', async () => {
      await post('/manage/clients?kind=application', application())

      const page = plain((await get('/manage/clients')).body)

      expect(page).toContain('<h1>Clients</h1>')
      expect(page).toContain('Web shop')
      expect(page).toContain('<code>zz-web</code>')
      expect(page).toContain('Application')
      expect(page).toMatch(/pforte-admin-ui[\s\S]*?Built in/)
      expect(page).toContain('aria-current="page">Clients</a>')
    })
  })

  describe('creating', () => {
    it('first asks what the client does', async () => {
      const page = await get('/manage/clients/new')

      expect(page.body).toContain('What will the client do?')
      expect(page.body).toContain('href="/manage/clients/new?kind=application"')
      expect(page.body).toContain('href="/manage/clients/new?kind=machine"')
    })

    it('creates a public application, which has no secret', async () => {
      const response = await post('/manage/clients?kind=application', application())
      const page = await follow(response)

      expect(response.headers.location).toBe('/manage/clients/zz-web')
      expect(page.body).toContain('The client Web shop was created.')
      expect(await row('zz-web')).toMatchObject({
        type: 'public',
        redirect_uris: ['https://shop.example.com/callback'],
        scopes: ['openid', 'profile', 'email'],
        allowed_grants: ['authorization_code', 'refresh_token'],
        secret_hash: null,
        pkce_required: true,
      })
    })

    it('shows the secret of a confidential client once, and stores only its hash', async () => {
      const created = await post('/manage/clients?kind=application', application({ type: 'confidential', pkce: 'on' }))

      expect(created.statusCode).toBe(200)
      expect(created.headers['cache-control']).toBe('no-store')
      const secret = /<code class="secret">([^<]+)<\/code>/.exec(created.body)?.[1]
      expect(secret?.length).toBeGreaterThanOrEqual(40)
      const stored = await row('zz-web')
      expect(stored.secret_hash).toMatch(/^\$argon2/)
      expect(stored.secret_hash).not.toContain(secret!)

      expect((await get('/manage/clients/zz-web')).body).not.toContain(secret!)
    })

    it('creates a machine with the rights that were ticked, and shows its secret', async () => {
      const created = await post('/manage/clients?kind=machine', { clientId: 'zz-importer', name: 'Importer', scopes: ['directory'] })

      expect(created.statusCode).toBe(200)
      expect(created.body).toContain('The secret of Importer')
      expect(await row('zz-importer')).toMatchObject({ type: 'confidential', scopes: ['directory'], allowed_grants: ['client_credentials'] })
    })

    it('comes back with what was typed and says what is wrong, field by field', async () => {
      const response = await post('/manage/clients?kind=application', application({ redirectUris: 'http://shop.example.com/callback', name: 'My <b>shop</b>' }))

      expect(response.statusCode).toBe(422)
      expect(response.body).toContain('Some entries need your attention.')
      expect(response.body).toContain('http://shop.example.com/callback')
      expect(response.body).toContain('must be an https URL')
      expect(response.body).toContain('value="My &lt;b&gt;shop&lt;/b&gt;"')
      expect(await row('zz-web')).toBeUndefined()
    })

    it('refuses a machine without any right', async () => {
      const response = await post('/manage/clients?kind=machine', { clientId: 'zz-nothing', name: 'Nothing' })

      expect(response.statusCode).toBe(422)
      expect(await row('zz-nothing')).toBeUndefined()
    })

    it('says so when the client ID is taken', async () => {
      await post('/manage/clients?kind=application', application())

      const again = await post('/manage/clients?kind=application', application())

      expect(again.statusCode).toBe(409)
      expect(again.body).toContain('already exists')
    })
  })

  describe('one client', () => {
    beforeEach(async () => {
      await post('/manage/clients?kind=application', application())
    })

    it('shows the settings, the claim types to tick, and the actions', async () => {
      const page = plain((await get('/manage/clients/zz-web')).body)

      expect(page).toContain('<h1>Web shop</h1>')
      expect(page).toContain('value="https://shop.example.com/callback"'.replace('value="', '>').replace('"', ''))
      expect(page).toContain('name="claimType" value="team_code"')
      expect(page).toContain('href="/manage/clients/zz-web/delete"')
      // public: nothing to replace
      expect(page).not.toContain('/rotate-secret')
    })

    it('saves changes and says when there were none', async () => {
      const saved = await follow(await post('/manage/clients/zz-web', application({ name: 'Webshop', redirectUris: 'https://shop.example.com/a\nhttps://shop.example.com/b' })))

      expect(saved.body).toContain('The client Webshop was saved.')
      expect((await row('zz-web')).redirect_uris).toEqual(['https://shop.example.com/a', 'https://shop.example.com/b'])

      const same = await follow(await post('/manage/clients/zz-web', application({ name: 'Webshop', redirectUris: 'https://shop.example.com/a\nhttps://shop.example.com/b' })))
      expect(same.body).toContain('Nothing was changed.')
    })

    it('does not change the type or the ID, whatever the form says', async () => {
      await post('/manage/clients/zz-web', application({ type: 'confidential', clientId: 'zz-other' }))

      expect(await row('zz-web')).toMatchObject({ type: 'public' })
      expect(await row('zz-other')).toBeUndefined()
    })

    it('keeps what was typed when the change is refused', async () => {
      const response = await post('/manage/clients/zz-web', application({ redirectUris: '' }))

      expect(response.statusCode).toBe(422)
      expect(response.body).toContain('at least one redirect URI')
      expect((await row('zz-web')).redirect_uris).toEqual(['https://shop.example.com/callback'])
    })

    it('assigns claim types to the client', async () => {
      const saved = await follow(await post('/manage/clients/zz-web/claim-types', { claimType: ['team_code', 'region'] }))

      expect(saved.body).toContain('The claims of Web shop were saved.')
      expect((await h.database.pool.query(`select claim_type_key from client_claim_types where client_id = 'zz-web' order by 1`)).rows.map((r) => r.claim_type_key)).toEqual(['region', 'team_code'])
      expect(plain(saved.body)).toMatch(/name="claimType" value="team_code" checked/)

      await post('/manage/clients/zz-web/claim-types', {})
      expect((await h.database.pool.query(`select 1 from client_claim_types where client_id = 'zz-web'`)).rowCount).toBe(0)
    })

    it('shows the claim types where a type is used', async () => {
      await post('/manage/clients/zz-web/claim-types', { claimType: ['team_code'] })

      expect((await get('/manage/claim-types/team_code')).body).toContain('href="/manage/clients/zz-web"')
    })

    it('escapes what an administrator typed', async () => {
      await post('/manage/clients/zz-web', application({ name: '<script>alert(1)</script>' }))

      const page = plain((await get('/manage/clients/zz-web')).body)
      expect(page).not.toContain('<script>alert(1)')
      expect(page).toContain('&lt;script&gt;alert(1)')
    })

    it('answers 404 for an unknown client', async () => {
      expect((await get('/manage/clients/zz-nothing')).statusCode).toBe(404)
      expect((await post('/manage/clients/zz-nothing', {})).statusCode).toBe(404)
      expect((await get('/manage/clients/zz-nothing/delete')).statusCode).toBe(404)
    })
  })

  describe('the client of the administration itself', () => {
    it('can be looked at but not changed, replaced or deleted', async () => {
      const page = plain((await get('/manage/clients/pforte-admin-ui')).body)

      expect(page).toContain('belongs to pforte itself')
      expect(page).not.toContain('<form class="fields" method="post" action="/manage/clients/pforte-admin-ui">')
      expect(page).not.toContain('/pforte-admin-ui/delete')

      expect((await post('/manage/clients/pforte-admin-ui', application({ name: 'Mine' }))).statusCode).toBe(409)
      const attempt = await post('/manage/clients/pforte-admin-ui/delete', { confirmId: 'pforte-admin-ui' })
      expect(attempt.statusCode).toBeGreaterThanOrEqual(400)
      expect((await row('pforte-admin-ui')).name).not.toBe('Mine')
    })
  })

  describe('replacing the secret', () => {
    beforeEach(async () => {
      await post('/manage/clients?kind=application', application({ type: 'confidential', pkce: 'on' }))
    })

    it('asks first, then shows the new secret once', async () => {
      const before = (await row('zz-web')).secret_hash
      const confirm = await get('/manage/clients/zz-web/rotate-secret')
      expect(confirm.body).toContain('Replace the secret of Web shop?')
      expect((await row('zz-web')).secret_hash).toBe(before)

      const done = await post('/manage/clients/zz-web/rotate-secret')

      expect(done.statusCode).toBe(200)
      expect(done.headers['cache-control']).toBe('no-store')
      expect(/<code class="secret">([^<]+)<\/code>/.exec(done.body)?.[1]?.length).toBeGreaterThanOrEqual(40)
      expect((await row('zz-web')).secret_hash).not.toBe(before)
    })

    it('is not possible for a public client', async () => {
      await post('/manage/clients?kind=application', application({ clientId: 'zz-app' }))

      const page = await get('/manage/clients/zz-app/rotate-secret')

      expect(page.body).toContain('cannot be changed or deleted')
      expect(page.body).not.toContain('class="danger"')
    })
  })

  describe('deleting', () => {
    beforeEach(async () => {
      await post('/manage/clients?kind=application', application())
    })

    it('asks for the client ID and refuses another one', async () => {
      const response = await post('/manage/clients/zz-web/delete', { confirmId: 'zz-wrong' })

      expect(response.statusCode).toBe(422)
      expect(response.body).toContain('not the ID of this client')
      expect(await row('zz-web')).toBeDefined()
    })

    it('deletes when the ID matches, and goes back to the list', async () => {
      const confirm = await get('/manage/clients/zz-web/delete')
      expect(confirm.body).toContain('type the client ID zz-web')

      const response = await post('/manage/clients/zz-web/delete', { confirmId: 'zz-web' })

      expect(response.headers.location).toBe('/manage/clients')
      expect((await follow(response)).body).toContain('The client Web shop was deleted.')
      expect(await row('zz-web')).toBeUndefined()
    })

    it('is recorded with the person who did it', async () => {
      await post('/manage/clients/zz-web/delete', { confirmId: 'zz-web' })

      const { rows } = await h.database.pool.query(`select actor_type from audit_events where action = 'client.delete' and target_id = 'zz-web'`)
      expect(rows[0]?.actor_type).toBe('user')
    })
  })

  it('shows the texts in German for an administrator who uses German', async () => {
    await h.database.pool.query(`update users set language = 'de' where email = 'admin@example.com'`)
    browser = await signedInToManage(h, Browser)

    expect((await get('/manage/clients')).body).toContain('Neuer Client')
    expect((await get('/manage/clients/new')).body).toContain('Was soll der Client tun?')
  })
})
