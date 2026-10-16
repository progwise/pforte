import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { basicAuth, Browser, signIn, verifyJwt } from '../test/browser.js'

const WEB = { clientId: 'demo-web', redirectUri: 'http://localhost:3400/callback' }
const BACKEND = { clientId: 'demo-backend', redirectUri: 'http://localhost:3500/callback' }

describe.skipIf(!hasDatabase)('admin API: claims and claim types', () => {
  let h: AdminHarness

  beforeAll(async () => {
    h = await createAdminHarness()
  })

  afterAll(async () => {
    await h?.close()
  })

  let counter = 0
  const newUser = async () =>
    (await h.api('POST', '/users', { body: { email: `claims${++counter}@example.com`, firstName: 'C', lastName: `${counter}` } })).json()

  /** Signs in as an existing seeded user and returns the claims of the ID token. */
  const idTokenClaims = async (client: typeof WEB, email: string, secret?: string) => {
    const browser = new Browser(h.app)
    const { code, verifier } = await signIn(browser, { ...client, email })
    const tokens = (
      await browser.request('POST', '/token', {
        form: {
          grant_type: 'authorization_code',
          code: code!,
          redirect_uri: client.redirectUri,
          client_id: client.clientId,
          code_verifier: verifier,
        },
        headers: secret ? { authorization: basicAuth(client.clientId, secret) } : {},
      })
    ).json()
    return (await verifyJwt(h.app, tokens.id_token)).claims
  }

  const discoveryClaims = async () => (await h.app.inject({ method: 'GET', url: '/.well-known/openid-configuration' })).json().claims_supported

  describe('claims of a user', () => {
    it('sets claims in bulk and replaces only the claim types given', async () => {
      const user = await newUser()
      await h.api('PUT', `/users/${user.id}/claims`, { body: { claims: { partner_no: ['00001'], customer_no: ['10001'], branch_code: ['MUC'] } } })

      const response = await h.api('PUT', `/users/${user.id}/claims`, { body: { claims: { partner_no: ['00002', '00003'] } } })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        changed: true,
        claims: { partner_no: ['00002', '00003'], customer_no: ['10001'], branch_code: ['MUC'] },
      })
      expect((await h.api('GET', `/users/${user.id}/claims`)).json().claims.customer_no).toEqual(['10001'])
    })

    it('says unchanged and records nothing when the bulk set changes nothing', async () => {
      const user = await newUser()
      await h.api('PUT', `/users/${user.id}/claims`, { body: { claims: { partner_no: ['00001'] } } })
      const events = (await h.audit('user.claims.set', user.id)).length

      const again = await h.api('PUT', `/users/${user.id}/claims`, { body: { claims: { partner_no: ['00001'] } } })

      expect(again.json().changed).toBe(false)
      expect(await h.audit('user.claims.set', user.id)).toHaveLength(events)
    })

    it('rejects invalid claims with every problem listed and changes nothing', async () => {
      const user = await newUser()
      await h.api('PUT', `/users/${user.id}/claims`, { body: { claims: { branch_code: ['KEEP'] } } })

      const response = await h.api('PUT', `/users/${user.id}/claims`, {
        body: { claims: { partner_no: ['abc'], customer_no: ['10001', '10002'], nonsense: ['x'], branch_code: ['CHANGED'] } },
      })

      expect(response.statusCode).toBe(400)
      expect(response.headers['content-type']).toMatch(/application\/problem\+json/)
      expect(response.json().errors.map((error: { path: string }) => error.path).sort()).toEqual([
        '/claims/customer_no',
        '/claims/nonsense',
        '/claims/partner_no',
      ])
      expect((await h.api('GET', `/users/${user.id}/claims`)).json().claims).toEqual({ branch_code: ['KEEP'] })
    })

    it('sets, adds and removes single values', async () => {
      const user = await newUser()

      await h.api('PUT', `/users/${user.id}/claims/partner_no`, { body: { values: ['00001'] } })
      const added = await h.api('POST', `/users/${user.id}/claims/partner_no`, { body: { value: '00002' } })
      const addedAgain = await h.api('POST', `/users/${user.id}/claims/partner_no`, { body: { value: '00002' } })
      const removed = await h.api('DELETE', `/users/${user.id}/claims/partner_no/00001`)
      const removedAgain = await h.api('DELETE', `/users/${user.id}/claims/partner_no/00001`)

      expect(added.json()).toMatchObject({ changed: true, claims: { partner_no: ['00001', '00002'] } })
      expect(addedAgain.json().changed).toBe(false)
      expect(removed.json()).toMatchObject({ changed: true, claims: { partner_no: ['00002'] } })
      expect(removedAgain.json().changed).toBe(false)
    })

    it('refuses a second value for a single-valued type with 409', async () => {
      const user = await newUser()
      await h.api('PUT', `/users/${user.id}/claims/customer_no`, { body: { values: ['10001'] } })

      const response = await h.api('POST', `/users/${user.id}/claims/customer_no`, { body: { value: '10002' } })

      expect(response.statusCode).toBe(409)
    })

    it('handles values with spaces in the path', async () => {
      const user = await newUser()
      await h.api('PUT', `/users/${user.id}/claims/branch_code`, { body: { values: ['North West'] } })

      const response = await h.api('DELETE', `/users/${user.id}/claims/branch_code/North%20West`)

      expect(response.json().claims).toEqual({})
    })

    it('answers 404 for an unknown user and 400 for a malformed claim type', async () => {
      expect((await h.api('GET', '/users/0190f6a8-0000-7000-8000-000000000000/claims')).statusCode).toBe(404)
      expect((await h.api('PUT', '/users/0190f6a8-0000-7000-8000-000000000000/claims', { body: { claims: {} } })).statusCode).toBe(404)
      const user = await newUser()
      expect((await h.api('PUT', `/users/${user.id}/claims/Not-A-Key`, { body: { values: [] } })).statusCode).toBe(400)
    })

    it('records who changed which claims', async () => {
      const user = await newUser()

      await h.api('PUT', `/users/${user.id}/claims`, { body: { claims: { partner_no: ['00007'] } } })

      const [event] = await h.audit('user.claims.set', user.id)
      expect(event).toMatchObject({ actor_type: 'client', actor_id: 'demo-admin', user_agent: 'admin-test/1.0' })
      expect(event.details.changes).toEqual({ partner_no: { from: [], to: ['00007'] } })
    })

    it('can be done with the directory scope', async () => {
      const user = await newUser()

      const response = await h.api('PUT', `/users/${user.id}/claims`, { token: h.directoryToken, body: { claims: { partner_no: ['00008'] } } })

      expect(response.statusCode).toBe(200)
    })
  })

  describe('upsert with claims', () => {
    const upsert = (email: string, body: Record<string, unknown>) => h.api('PUT', `/users/by-email/${encodeURIComponent(email)}`, { body })

    it('creates the user with claims in one call, and an identical repeat says unchanged', async () => {
      const body = { firstName: 'Im', lastName: 'Port', claims: { partner_no: ['00010', '00011'], customer_no: ['10010'] } }

      const first = await upsert('with-claims@example.com', body)
      const again = await upsert('with-claims@example.com', body)

      expect(first.statusCode).toBe(201)
      expect(first.json()).toMatchObject({ outcome: 'created', claims: { partner_no: ['00010', '00011'], customer_no: ['10010'] } })
      expect(again.json().outcome).toBe('unchanged')
    })

    it('says updated when only the claims differ, and leaves other claim types alone', async () => {
      await upsert('claims-only@example.com', { firstName: 'Co', lastName: 'Only', claims: { partner_no: ['00001'], branch_code: ['MUC'] } })

      const response = await upsert('claims-only@example.com', { firstName: 'Co', lastName: 'Only', claims: { partner_no: ['00002'] } })

      expect(response.json()).toMatchObject({ outcome: 'updated', claims: { partner_no: ['00002'], branch_code: ['MUC'] } })
    })

    it('leaves the claims alone when the field is left out', async () => {
      await upsert('keeps@example.com', { firstName: 'Ke', lastName: 'Eps', claims: { partner_no: ['00001'] } })

      const response = await upsert('keeps@example.com', { firstName: 'Ke', lastName: 'Eps' })

      expect(response.json()).toMatchObject({ outcome: 'unchanged', claims: { partner_no: ['00001'] } })
    })

    it('creates nothing at all when a claim is invalid', async () => {
      const users = await h.count('users')
      const events = await h.count('audit_events')

      const response = await upsert('atomic@example.com', { firstName: 'At', lastName: 'Omic', claims: { partner_no: ['not-a-number'] } })

      expect(response.statusCode).toBe(400)
      expect(await h.count('users')).toBe(users)
      expect(await h.count('audit_events')).toBe(events)
    })
  })

  describe('what applications receive', () => {
    it('puts claims set through the API into the next ID token', async () => {
      const carla = 'carla.berger@example.com'
      const user = (await h.api('GET', `/users?search=${carla}`)).json().items[0]
      await h.api('PUT', `/users/${user.id}/claims`, { body: { claims: { partner_no: ['00555'], customer_no: ['10555'] } } })

      const claims = await idTokenClaims(BACKEND, carla, 'dev-secret')

      expect(claims).toMatchObject({ partner_no: ['00555'], customer_no: '10555' })
    })

    it('gives a client only the claim types assigned to it, and a new assignment applies at once', async () => {
      await h.api('POST', '/claim-types', { body: { key: 'cost_center', description: 'Cost center' } })
      const emma = (await h.api('GET', '/users?search=emma.vogel@')).json().items[0]
      await h.api('PUT', `/users/${emma.id}/claims`, { body: { claims: { cost_center: ['CC-7'] } } })

      const before = await idTokenClaims(WEB, 'emma.vogel@example.com')
      expect(before).not.toHaveProperty('cost_center')

      const assigned = await h.api('PUT', '/clients/demo-web/claim-types', { body: { claimTypes: ['partner_no', 'cost_center'] } })
      expect(assigned.statusCode).toBe(200)

      const after = await idTokenClaims(WEB, 'emma.vogel@example.com')
      expect(after.cost_center).toBe('CC-7')
    })
  })

  describe('claim types', () => {
    it('lists the claim types with the clients that receive them', async () => {
      const response = await h.api('GET', '/claim-types', { token: h.directoryToken })

      expect(response.statusCode).toBe(200)
      const partnerNo = response.json().items.find((type: { key: string }) => type.key === 'partner_no')
      expect(partnerNo).toMatchObject({ multiValued: true, valuePattern: '^[0-9]{5}$' })
      expect(partnerNo.clients).toEqual(expect.arrayContaining(['demo-backend', 'demo-web']))
    })

    it('needs the admin scope to change them', async () => {
      const response = await h.api('POST', '/claim-types', { token: h.directoryToken, body: { key: 'sneaky' } })

      expect(response.statusCode).toBe(403)
    })

    it('creates a claim type, announces it in discovery at once and records it', async () => {
      expect(await discoveryClaims()).not.toContain('region')

      const response = await h.api('POST', '/claim-types', { body: { key: 'region', description: 'Sales region', valuePattern: '^[A-Z]{2}$', multiValued: false } })

      expect(response.statusCode).toBe(201)
      expect(response.headers.location).toBe('/admin/claim-types/region')
      expect(response.json()).toEqual({ key: 'region', description: 'Sales region', valuePattern: '^[A-Z]{2}$', multiValued: false, clients: [] })
      expect(await discoveryClaims()).toContain('region')
      const [event] = await h.audit('claim_type.create', 'region')
      expect(event).toMatchObject({ actor_id: 'demo-admin' })
    })

    it.each([
      ['a reserved name', { key: 'email' }, '/key'],
      ['another reserved name', { key: 'sub' }, '/key'],
      ['an invalid key', { key: 'Not A Key' }, '/key'],
      ['an invalid pattern', { key: 'broken', valuePattern: '([' }, '/valuePattern'],
    ])('rejects %s', async (_name, body, path) => {
      const response = await h.api('POST', '/claim-types', { body })

      expect(response.statusCode).toBe(400)
      expect(JSON.stringify(response.json())).toContain(path)
    })

    it('refuses a claim type that exists', async () => {
      expect((await h.api('POST', '/claim-types', { body: { key: 'partner_no' } })).statusCode).toBe(409)
    })

    it('changes the description, but refuses a pattern that existing values violate', async () => {
      await h.api('POST', '/claim-types', { body: { key: 'tag' } })
      const user = await newUser()
      await h.api('PUT', `/users/${user.id}/claims/tag`, { body: { values: ['abc'] } })

      expect((await h.api('PATCH', '/claim-types/tag', { body: { description: 'A tag' } })).json().description).toBe('A tag')
      const refused = await h.api('PATCH', '/claim-types/tag', { body: { valuePattern: '^[0-9]+$' } })

      expect(refused.statusCode).toBe(409)
      expect(refused.json().detail).toContain('1 existing value')
    })

    it('refuses to delete a claim type that users hold, and says how many', async () => {
      await h.api('POST', '/claim-types', { body: { key: 'held' } })
      const user = await newUser()
      await h.api('PUT', `/users/${user.id}/claims/held`, { body: { values: ['x'] } })

      const response = await h.api('DELETE', '/claim-types/held')

      expect(response.statusCode).toBe(409)
      expect(response.json().detail).toContain('1 user(s) hold 1 value(s)')
      expect(await discoveryClaims()).toContain('held')
    })

    it('deletes a held claim type with force, and records how many values went', async () => {
      await h.api('POST', '/claim-types', { body: { key: 'forced' } })
      const user = await newUser()
      await h.api('PUT', `/users/${user.id}/claims/forced`, { body: { values: ['x'] } })

      const response = await h.api('DELETE', '/claim-types/forced?force=true')

      expect(response.statusCode).toBe(204)
      expect(await discoveryClaims()).not.toContain('forced')
      expect((await h.api('GET', `/users/${user.id}/claims`)).json().claims).toEqual({})
      const [event] = await h.audit('claim_type.delete', 'forced')
      expect(event.details).toMatchObject({ forced: true, usersAffected: 1, valuesDeleted: 1 })
    })

    it('deletes an unused claim type, and answers 404 for one that does not exist', async () => {
      await h.api('POST', '/claim-types', { body: { key: 'spare' } })

      expect((await h.api('DELETE', '/claim-types/spare')).statusCode).toBe(204)
      expect((await h.api('DELETE', '/claim-types/spare')).statusCode).toBe(404)
    })
  })

  describe('requests that are not well formed', () => {
    const raw = (method: 'DELETE' | 'POST', url: string, headers: Record<string, string>, payload?: string) =>
      h.app.inject({ method, url: `/admin${url}`, headers: { authorization: `Bearer ${h.adminToken}`, ...headers }, payload })

    it('accepts a DELETE that sends a JSON content type but no body', async () => {
      const user = await newUser()

      const response = await raw('DELETE', `/users/${user.id}`, { 'content-type': 'application/json' })

      expect(response.statusCode).toBe(204)
    })

    it('answers broken JSON with 400, not 500', async () => {
      const response = await raw('POST', '/users', { 'content-type': 'application/json' }, '{"email": ')

      expect(response.statusCode).toBe(400)
      expect(response.headers['content-type']).toMatch(/application\/problem\+json/)
    })

    it('answers a body of the wrong type with 415, not 500', async () => {
      const response = await raw('POST', '/users', { 'content-type': 'application/xml' }, '<user/>')

      expect(response.statusCode).toBe(415)
      expect(response.headers['content-type']).toMatch(/application\/problem\+json/)
    })
  })

  describe('claim types of a client', () => {
    it('reads and replaces the set', async () => {
      const read = await h.api('GET', '/clients/demo-backend/claim-types')
      expect(read.json().claimTypes).toEqual(expect.arrayContaining(['partner_no', 'customer_no', 'branch_code']))

      const replaced = await h.api('PUT', '/clients/demo-backend/claim-types', { body: { claimTypes: ['partner_no'] } })
      expect(replaced.json().claimTypes).toEqual(['partner_no'])
      await h.api('PUT', '/clients/demo-backend/claim-types', { body: { claimTypes: ['branch_code', 'customer_no', 'partner_no'] } })
    })

    it('refuses an unknown claim type, answers 404 for an unknown client, and needs the admin scope', async () => {
      const unknownType = await h.api('PUT', '/clients/demo-web/claim-types', { body: { claimTypes: ['nothing_like_it'] } })
      expect(unknownType.statusCode).toBe(400)

      expect((await h.api('PUT', '/clients/ghost/claim-types', { body: { claimTypes: [] } })).statusCode).toBe(404)
      expect((await h.api('GET', '/clients/ghost/claim-types')).statusCode).toBe(404)
      expect((await h.api('GET', '/clients/demo-web/claim-types', { token: h.directoryToken })).statusCode).toBe(403)
    })
  })
})
