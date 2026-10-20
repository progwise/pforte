import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AdminHarness, createAdminHarness, ISSUER } from '../test/admin-harness.js'
import { basicAuth, Browser, signIn } from '../test/browser.js'

describe.skipIf(!hasDatabase)('admin API: users', () => {
  let h: AdminHarness
  let app: AdminHarness['app']
  let database: AdminHarness['database']
  let directoryToken: string

  beforeAll(async () => {
    h = await createAdminHarness()
    app = h.app
    database = h.database
    directoryToken = h.directoryToken
  })

  afterAll(async () => {
    await h?.close()
  })

  const tokenFor = (clientId: string, scope: string) => h.tokenFor(clientId, scope)
  const api = (...args: Parameters<AdminHarness['api']>) => h.api(...args)
  const count = (table: string, where?: string) => h.count(table, where)
  const auditFor = (action: string, targetId: string) => h.audit(action, targetId)

  describe('authentication', () => {
    it('refuses a call without a token', async () => {
      const response = await api('GET', '/users', { token: null })

      expect(response.statusCode).toBe(401)
      expect(response.headers['content-type']).toMatch(/application\/problem\+json/)
      expect(response.headers['www-authenticate']).toMatch(/^Bearer/)
    })

    it('refuses a token it did not issue', async () => {
      expect((await api('GET', '/users', { token: 'not-a-token' })).statusCode).toBe(401)
    })

    it('refuses an access token from the authorization code flow', async () => {
      const browser = new Browser(app)
      const { code, verifier } = await signIn(browser, {
        clientId: 'demo-backend',
        redirectUri: 'http://localhost:3500/callback',
      })
      const tokens = (
        await browser.request('POST', '/token', {
          form: {
            grant_type: 'authorization_code',
            code: code!,
            redirect_uri: 'http://localhost:3500/callback',
            client_id: 'demo-backend',
            code_verifier: verifier,
          },
          headers: { authorization: basicAuth('demo-backend', 'dev-secret') },
        })
      ).json()

      expect((await api('GET', '/users', { token: tokens.access_token })).statusCode).toBe(401)
    })

    it('does not give an application the client_credentials grant or an admin scope', async () => {
      const grant = await app.inject({
        method: 'POST',
        url: '/token',
        headers: { authorization: basicAuth('demo-backend', 'dev-secret'), 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ grant_type: 'client_credentials', scope: 'admin' }).toString(),
      })
      expect(grant.statusCode).toBeGreaterThanOrEqual(400)
      expect(grant.json()).not.toHaveProperty('access_token')

      // An admin client cannot ask for more than it is registered for.
      const tooMuch = await app.inject({
        method: 'POST',
        url: '/token',
        headers: { authorization: basicAuth('demo-import', 'dev-secret'), 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ grant_type: 'client_credentials', scope: 'admin' }).toString(),
      })
      expect(tooMuch.statusCode).toBe(400)
      expect(tooMuch.json().error).toBe('invalid_scope')
    })

    it('does not let the authorization code flow ask for the admin scope', async () => {
      const query = new URLSearchParams({
        client_id: 'demo-backend',
        redirect_uri: 'http://localhost:3500/callback',
        response_type: 'code',
        scope: 'openid admin',
        state: 's',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
      })

      const response = await new Browser(app).request('GET', `/auth?${query}`)

      expect(new URL(response.headers.location as string, ISSUER).searchParams.get('error')).toBe('invalid_scope')
    })

    it('takes a removed scope into effect at once, not when the token expires', async () => {
      const token = await tokenFor('demo-admin', 'admin')
      expect((await api('GET', '/users?limit=1', { token })).statusCode).toBe(200)

      await database.pool.query(`update clients set scopes = '{}' where client_id = 'demo-admin'`)
      try {
        expect((await api('GET', '/users?limit=1', { token })).statusCode).toBe(403)
      } finally {
        await database.pool.query(`update clients set scopes = '{admin}' where client_id = 'demo-admin'`)
      }
    })

    it('lets the directory scope manage users but not grant administrator rights', async () => {
      const created = await api('POST', '/users', {
        token: directoryToken,
        body: { email: 'dir@example.com', firstName: 'Dir', lastName: 'Ectory' },
      })
      expect(created.statusCode).toBe(201)

      const escalate = await api('PATCH', `/users/${created.json().id}`, { token: directoryToken, body: { isAdmin: true } })
      expect(escalate.statusCode).toBe(403)
      expect((await api('GET', `/users/${created.json().id}`)).json().isAdmin).toBe(false)

      const granted = await api('PATCH', `/users/${created.json().id}`, { body: { isAdmin: true } })
      expect(granted.statusCode).toBe(200)
      expect(granted.json().isAdmin).toBe(true)
    })
  })

  describe('create, read, change, delete', () => {
    it('creates a user in status created and records who did it', async () => {
      const response = await api('POST', '/users', {
        body: { email: 'New.Person@Example.COM', firstName: 'New', lastName: 'Person', phone: '+4915112345678', language: 'de' },
      })

      expect(response.statusCode).toBe(201)
      const user = response.json()
      expect(response.headers.location).toBe(`/admin/users/${user.id}`)
      expect(user).toMatchObject({ email: 'new.person@example.com', status: 'created', isAdmin: false, language: 'de' })
      expect(user).not.toHaveProperty('passwordHash')
      expect(user).not.toHaveProperty('activationTokenHash')

      const [event] = await auditFor('user.create', user.id)
      expect(event).toMatchObject({
        actor_type: 'client',
        actor_id: 'demo-admin',
        target_type: 'user',
        user_agent: 'admin-test/1.0',
      })
      expect(event.ip).toBeTruthy()
      expect(event.details).toMatchObject({ email: 'new.person@example.com' })
    })

    it('refuses a second user with the same e-mail and leaves no trace of the attempt', async () => {
      await api('POST', '/users', { body: { email: 'twin@example.com', firstName: 'T', lastName: 'One' } })
      const users = await count('users')
      const events = await count('audit_events')

      const response = await api('POST', '/users', { body: { email: 'TWIN@example.com', firstName: 'T', lastName: 'Two' } })

      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ title: 'Conflict', status: 409 })
      expect(await count('users')).toBe(users)
      expect(await count('audit_events')).toBe(events)
    })

    it.each([
      ['an invalid e-mail', { email: 'not-an-email', firstName: 'A', lastName: 'B' }, '/email'],
      ['a phone number that is not E.164', { email: 'p@example.com', firstName: 'A', lastName: 'B', phone: '0151 123' }, '/phone'],
      ['an empty name', { email: 'n@example.com', firstName: ' ', lastName: 'B' }, '/firstName'],
    ])('rejects %s with the offending field named', async (_name, body, path) => {
      const response = await api('POST', '/users', { body })

      expect(response.statusCode).toBe(400)
      expect(response.headers['content-type']).toMatch(/application\/problem\+json/)
      expect(response.json().errors.map((error: { path: string }) => error.path)).toContain(path)
    })

    it('gets a user, and answers 404 or 400 for a missing or malformed id', async () => {
      const created = (await api('POST', '/users', { body: { email: 'get@example.com', firstName: 'G', lastName: 'Et' } })).json()

      expect((await api('GET', `/users/${created.id}`)).json().email).toBe('get@example.com')
      expect((await api('GET', '/users/0190f6a8-0000-7000-8000-000000000000')).statusCode).toBe(404)
      expect((await api('GET', '/users/not-a-uuid')).statusCode).toBe(400)
    })

    it('changes only the given fields and records what changed', async () => {
      const created = (await api('POST', '/users', { body: { email: 'patch@example.com', firstName: 'Pat', lastName: 'Ch' } })).json()

      const response = await api('PATCH', `/users/${created.id}`, { body: { firstName: 'Patricia', phone: '+4915100000042' } })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ firstName: 'Patricia', lastName: 'Ch', phone: '+4915100000042' })
      const [event] = await auditFor('user.update', created.id)
      expect(event.details.changes).toEqual({
        firstName: { from: 'Pat', to: 'Patricia' },
        phone: { from: null, to: '+4915100000042' },
      })
    })

    it('records nothing when a change changes nothing, and refuses an empty change', async () => {
      const created = (await api('POST', '/users', { body: { email: 'same@example.com', firstName: 'Same', lastName: 'Old' } })).json()

      const same = await api('PATCH', `/users/${created.id}`, { body: { firstName: 'Same' } })
      expect(same.statusCode).toBe(200)
      expect(await auditFor('user.update', created.id)).toHaveLength(0)

      expect((await api('PATCH', `/users/${created.id}`, { body: {} })).statusCode).toBe(400)
    })

    it('refuses a change to an e-mail that belongs to someone else', async () => {
      const taken = (await api('POST', '/users', { body: { email: 'taken@example.com', firstName: 'T', lastName: 'K' } })).json()
      const other = (await api('POST', '/users', { body: { email: 'other@example.com', firstName: 'O', lastName: 'T' } })).json()

      const response = await api('PATCH', `/users/${other.id}`, { body: { email: 'taken@example.com' } })

      expect(response.statusCode).toBe(409)
      expect((await api('GET', `/users/${other.id}`)).json().email).toBe('other@example.com')
      expect(taken.id).not.toBe(other.id)
    })

    it('deletes a user with their claims and keeps who they were in the audit log', async () => {
      const created = (await api('POST', '/users', { body: { email: 'delete@example.com', firstName: 'Del', lastName: 'Ete' } })).json()
      await database.pool.query(
        `insert into user_claims (user_id, claim_type_key, value) values ($1, 'partner_no', '99999')`,
        [created.id],
      )

      const response = await api('DELETE', `/users/${created.id}`)

      expect(response.statusCode).toBe(204)
      expect((await api('GET', `/users/${created.id}`)).statusCode).toBe(404)
      expect(await count('user_claims', `user_id = '${created.id}'`)).toBe(0)
      const [event] = await auditFor('user.delete', created.id)
      expect(event.details).toMatchObject({ email: 'delete@example.com', firstName: 'Del', lastName: 'Ete' })
      expect((await api('DELETE', `/users/${created.id}`)).statusCode).toBe(404)
    })
  })

  describe('upsert by e-mail', () => {
    const upsert = (email: string, body: Record<string, unknown>) =>
      api('PUT', `/users/by-email/${encodeURIComponent(email)}`, { body })

    it('creates, then says unchanged for an identical repeat, and records only the first', async () => {
      const first = await upsert('import@example.com', { firstName: 'Im', lastName: 'Port', phone: '+4915100000100', language: 'de' })
      expect(first.statusCode).toBe(201)
      expect(first.json().outcome).toBe('created')
      const id = first.json().user.id

      const again = await upsert('import@example.com', { firstName: 'Im', lastName: 'Port', phone: '+4915100000100', language: 'de' })
      expect(again.statusCode).toBe(200)
      expect(again.json().outcome).toBe('unchanged')
      expect(await auditFor('user.create', id)).toHaveLength(1)
      expect(await auditFor('user.update', id)).toHaveLength(0)
    })

    it('updates what differs, and finds the user whatever the case of the e-mail', async () => {
      await upsert('case@example.com', { firstName: 'Case', lastName: 'Old' })

      const response = await upsert('CASE@Example.com', { firstName: 'Case', lastName: 'New' })

      expect(response.json()).toMatchObject({ outcome: 'updated', user: { email: 'case@example.com', lastName: 'New' } })
      expect(await count('users', `email = 'case@example.com'`)).toBe(1)
    })

    it('never touches status, password or administrator rights', async () => {
      const created = (await upsert('careful@example.com', { firstName: 'Care', lastName: 'Ful' })).json().user
      await database.pool.query(
        `update users set status = 'locked', password_hash = 'hash', is_admin = true where id = $1`,
        [created.id],
      )

      const response = await upsert('careful@example.com', { firstName: 'Carefully', lastName: 'Ful' })

      expect(response.json().user).toMatchObject({ status: 'locked', isAdmin: true, firstName: 'Carefully' })
      const row = (await database.pool.query(`select password_hash from users where id = $1`, [created.id])).rows[0]
      expect(row.password_hash).toBe('hash')
    })

    it('keeps the phone when it is not mentioned and clears it when it is null', async () => {
      await upsert('phone@example.com', { firstName: 'Ph', lastName: 'One', phone: '+4915100000200' })

      const kept = await upsert('phone@example.com', { firstName: 'Ph', lastName: 'One' })
      expect(kept.json()).toMatchObject({ outcome: 'unchanged', user: { phone: '+4915100000200' } })

      const cleared = await upsert('phone@example.com', { firstName: 'Ph', lastName: 'One', phone: null })
      expect(cleared.json()).toMatchObject({ outcome: 'updated', user: { phone: null } })
    })

    it('creates exactly one user when several imports arrive at the same time', async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, () => upsert('parallel@example.com', { firstName: 'Para', lastName: 'Llel' })),
      )

      expect(results.every((response) => response.statusCode === 200 || response.statusCode === 201)).toBe(true)
      expect(results.filter((response) => response.json().outcome === 'created')).toHaveLength(1)
      expect(await count('users', `email = 'parallel@example.com'`)).toBe(1)
    })

    it('can be called by an import client with only the directory scope', async () => {
      const response = await api('PUT', '/users/by-email/directory-import@example.com', {
        token: directoryToken,
        body: { firstName: 'Di', lastName: 'Rectory' },
      })

      expect(response.statusCode).toBe(201)
    })
  })

  describe('dry run of the upsert', () => {
    const dryRun = (email: string, body: Record<string, unknown>, token?: string) =>
      api('PUT', `/users/by-email/${encodeURIComponent(email)}?dryRun=true`, { body, token })
    const upsert = (email: string, body: Record<string, unknown>) =>
      api('PUT', `/users/by-email/${encodeURIComponent(email)}`, { body })

    it('says what would be created and what would be set, and creates nothing', async () => {
      const users = await count('users')
      const claims = await count('user_claims')
      const events = await count('audit_events')

      const response = await dryRun('dry-new@example.com', { firstName: 'Dry', lastName: 'New', language: 'de', claims: { partner_no: ['00501'] } })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        dryRun: true,
        outcome: 'created',
        changes: {
          profile: { email: { from: null, to: 'dry-new@example.com' }, firstName: { from: null, to: 'Dry' }, language: { from: null, to: 'de' } },
          claims: { partner_no: { from: [], to: ['00501'] } },
        },
      })
      expect(response.json()).not.toHaveProperty('user')
      expect(await count('users')).toBe(users)
      expect(await count('user_claims')).toBe(claims)
      expect(await count('audit_events')).toBe(events)
    })

    it('leaves nothing behind, so the real call afterwards still creates the user', async () => {
      await dryRun('dry-then-real@example.com', { firstName: 'Dry', lastName: 'Real' })

      const real = await upsert('dry-then-real@example.com', { firstName: 'Dry', lastName: 'Real' })

      expect(real.statusCode).toBe(201)
      expect(real.json()).toMatchObject({ dryRun: false, outcome: 'created' })
    })

    it('shows what would change for an existing user, without changing it', async () => {
      await upsert('dry-update@example.com', { firstName: 'Up', lastName: 'Date', claims: { partner_no: ['00001'], branch_code: ['MUC'] } })
      const events = await count('audit_events')

      const response = await dryRun('dry-update@example.com', { firstName: 'Up', lastName: 'Dated', claims: { partner_no: ['00002'] } })

      expect(response.json()).toMatchObject({
        dryRun: true,
        outcome: 'updated',
        changes: { profile: { lastName: { from: 'Date', to: 'Dated' } }, claims: { partner_no: { from: ['00001'], to: ['00002'] } } },
      })
      expect(Object.keys(response.json().changes.profile)).toEqual(['lastName'])
      const after = (await api('GET', `/users?search=dry-update`)).json().items[0]
      expect(after.lastName).toBe('Date')
      expect(await count('audit_events')).toBe(events)
    })

    it('says unchanged, with no changes, when the call would change nothing', async () => {
      await upsert('dry-same@example.com', { firstName: 'Same', lastName: 'Same', claims: { partner_no: ['00003'] } })

      const response = await dryRun('dry-same@example.com', { firstName: 'Same', lastName: 'Same', claims: { partner_no: ['00003'] } })

      expect(response.json()).toEqual({ dryRun: true, outcome: 'unchanged', changes: { profile: {}, claims: {} } })
    })

    it('applies the same checks as the real call', async () => {
      const dry = await dryRun('dry-invalid@example.com', { firstName: 'In', lastName: 'Valid', claims: { partner_no: ['abc'], nonsense: ['x'] } })
      const real = await upsert('dry-invalid@example.com', { firstName: 'In', lastName: 'Valid', claims: { partner_no: ['abc'], nonsense: ['x'] } })

      expect(dry.statusCode).toBe(400)
      expect(dry.json()).toEqual(real.json())
      expect((await dryRun('dry-invalid@example.com', { firstName: '', lastName: 'x' })).statusCode).toBe(400)
      expect((await api('PUT', '/users/by-email/x@example.com?dryRun=maybe', { body: { firstName: 'A', lastName: 'B' } })).statusCode).toBe(400)
    })

    it('can be done with the directory scope', async () => {
      const response = await dryRun('dry-dir@example.com', { firstName: 'Di', lastName: 'Rectory' }, directoryToken)

      expect(response.statusCode).toBe(200)
      expect(response.json().dryRun).toBe(true)
    })

    it('answers an ordinary call with dryRun false', async () => {
      const response = await upsert('plain@example.com', { firstName: 'Plain', lastName: 'Call' })

      expect(response.json().dryRun).toBe(false)
    })
  })

  describe('list', () => {
    it('pages through every user once, in order', async () => {
      const everyone = await count('users')

      const seen: string[] = []
      let cursor: string | undefined
      do {
        const response = await api('GET', `/users?limit=7${cursor ? `&cursor=${cursor}` : ''}`)
        expect(response.statusCode).toBe(200)
        seen.push(...response.json().items.map((user: { id: string }) => user.id))
        cursor = response.json().nextCursor
      } while (cursor)

      expect(seen).toHaveLength(everyone)
      expect(new Set(seen).size).toBe(everyone)
    })

    it('searches by name or e-mail, filters by status and by claim value', async () => {
      const byName = (await api('GET', '/users?search=schmidt')).json().items
      expect(byName.map((user: { email: string }) => user.email)).toContain('anna.schmidt@example.com')

      const byClaim = (await api('GET', '/users?claim=partner_no:00892')).json().items
      expect(byClaim.map((user: { email: string }) => user.email)).toEqual(['anna.schmidt@example.com'])

      const created = (await api('GET', '/users?status=created&limit=200')).json().items
      expect(created.length).toBeGreaterThan(0)
      expect(created.every((user: { status: string }) => user.status === 'created')).toBe(true)

      expect((await api('GET', '/users?search=%25')).json().items).toHaveLength(0)
    })

    it.each(['limit=0', 'limit=201', 'status=asleep', 'claim=nocolon', 'cursor=nope', `search=${'a'.repeat(201)}`, `claim=team:${'b'.repeat(300)}`])('rejects %s', async (query) => {
      expect((await api('GET', `/users?${query}`)).statusCode).toBe(400)
    })
  })

  it('answers an unknown admin path with a problem document, not an HTML page', async () => {
    const response = await api('GET', '/nothing-here')

    expect(response.statusCode).toBe(404)
    expect(response.headers['content-type']).toMatch(/application\/problem\+json/)
  })
})
