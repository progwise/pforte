import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'

describe.skipIf(!hasDatabase)('admin API: the passkeys of a user', () => {
  let h: AdminHarness
  let annaId: string
  let benId: string

  beforeAll(async () => {
    h = await createAdminHarness()
    const idOf = async (email: string) => (await h.database.pool.query(`select id from users where email = $1`, [email])).rows[0].id as string
    annaId = await idOf('anna.schmidt@example.com')
    benId = await idOf('ben.keller@example.com')
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(async () => {
    await h.database.pool.query('delete from passkeys')
    await h.database.pool.query(`delete from audit_events where action like 'user.passkey.%'`)
  })

  /** A passkey as a device of the person made it; what is in it does not matter here. */
  const store = async (userId: string, name: string, { synced = false, lastUsed = false } = {}) =>
    (
      await h.database.pool.query(
        `insert into passkeys (user_id, credential_id, public_key, label, synced, last_used_at) values ($1, $2, $3, $4, $5, $6) returning id`,
        [userId, `credential-${name}`, `public-key-${name}`, name, synced, lastUsed ? new Date() : null],
      )
    ).rows[0].id as string

  it('lists nothing for somebody without a passkey', async () => {
    const response = await h.api('GET', `/users/${annaId}/passkeys`)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ items: [] })
  })

  it('lists the passkeys of that user, newest first, without the id a device knows them by and without the key', async () => {
    const first = await store(annaId, 'Safari, iPhone', { synced: true, lastUsed: true })
    const second = await store(annaId, 'Chrome, Windows')
    await store(benId, 'Firefox, Linux')

    const response = await h.api('GET', `/users/${annaId}/passkeys`)

    expect(response.json().items).toEqual([
      { id: second, label: 'Chrome, Windows', synced: false, createdAt: expect.any(String), lastUsedAt: null },
      { id: first, label: 'Safari, iPhone', synced: true, createdAt: expect.any(String), lastUsedAt: expect.any(String) },
    ])
    expect(response.body).not.toMatch(/credential-|public-key-|credentialId|publicKey/)
  })

  it('removes one and records who did it', async () => {
    const removed = await store(annaId, 'Safari, iPhone')
    const kept = await store(annaId, 'Chrome, Windows')

    const response = await h.api('DELETE', `/users/${annaId}/passkeys/${removed}`)

    expect(response.statusCode).toBe(204)
    expect((await h.api('GET', `/users/${annaId}/passkeys`)).json().items.map((item: { id: string }) => item.id)).toEqual([kept])
    const [event] = await h.audit('user.passkey.remove', annaId)
    expect(event).toMatchObject({ actor_type: 'client', actor_id: 'demo-admin' })
    expect(event.details).toMatchObject({ passkeyId: removed, label: 'Safari, iPhone' })
    // An administrator did it, not the person.
    expect(event.details).not.toHaveProperty('self')
  })

  it('answers 404 for a passkey the user does not have, also when somebody else has it', async () => {
    const bens = await store(benId, 'Firefox, Linux')

    expect((await h.api('DELETE', `/users/${annaId}/passkeys/${bens}`)).statusCode).toBe(404)
    expect((await h.api('DELETE', `/users/${annaId}/passkeys/018f0000-0000-7000-8000-000000000000`)).statusCode).toBe(404)
    expect(await h.count('passkeys')).toBe(1)
    expect(await h.audit('user.passkey.remove', benId)).toEqual([])
  })

  it('is open to the directory scope, refused without a token, and answers 404 and 400 for bad ids', async () => {
    const passkey = await store(annaId, 'Safari, iPhone')
    expect((await h.api('GET', `/users/${annaId}/passkeys`, { token: h.directoryToken })).statusCode).toBe(200)
    expect((await h.api('GET', `/users/${annaId}/passkeys`, { token: null })).statusCode).toBe(401)
    expect((await h.api('DELETE', `/users/${annaId}/passkeys/${passkey}`, { token: null })).statusCode).toBe(401)
    expect((await h.api('GET', `/users/018f0000-0000-7000-8000-000000000000/passkeys`)).statusCode).toBe(404)
    expect((await h.api('DELETE', `/users/018f0000-0000-7000-8000-000000000000/passkeys/${passkey}`)).statusCode).toBe(404)
    expect((await h.api('GET', `/users/not-an-id/passkeys`)).statusCode).toBe(400)
    expect((await h.api('DELETE', `/users/${annaId}/passkeys/not-an-id`)).statusCode).toBe(400)
    expect(await h.count('passkeys')).toBe(1)
  })

  it('has no way to create one: that is the person\'s own doing, on their device', async () => {
    expect((await h.api('POST', `/users/${annaId}/passkeys`, { body: {} })).statusCode).toBe(404)
  })
})
