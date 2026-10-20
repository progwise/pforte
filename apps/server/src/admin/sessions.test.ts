import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { Browser, signIn } from '../test/browser.js'

const WEB = { clientId: 'demo-web', redirectUri: 'http://localhost:3400/callback' }

describe.skipIf(!hasDatabase)('admin API: where a user is signed in', () => {
  let h: AdminHarness

  beforeAll(async () => {
    h = await createAdminHarness()
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(async () => {
    await h.database.pool.query('delete from rate_limits')
    await h.database.pool.query('delete from oidc_payloads where account_id is not null')
    await h.database.pool.query('delete from otp_codes')
  })

  const userId = async (email: string) => (await h.database.pool.query(`select id from users where email = $1`, [email])).rows[0].id as string
  const sessions = async (id: string, token = h.adminToken) => h.api('GET', `/users/${id}/sessions`, { token })

  it('lists nothing for somebody who is not signed in anywhere', async () => {
    const response = await sessions(await userId('ben.keller@example.com'))
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ sessions: [], grants: [] })
  })

  it('lists the browser session and the application that was signed in to, by name', async () => {
    const result = await signIn(new Browser(h.app), { ...WEB, email: 'ben.keller@example.com' })
    expect(result.code).toBeTruthy()

    const body = (await sessions(await userId('ben.keller@example.com'))).json()
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0]).toMatchObject({
      acr: 'urn:pforte:acr:mfa',
      applications: [{ clientId: 'demo-web', name: expect.any(String) }],
    })
    expect(new Date(body.sessions[0].startedAt).getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(new Date(body.sessions[0].expiresAt).getTime()).toBeGreaterThan(Date.now())
    expect(body.grants).toEqual([{ clientId: 'demo-web', name: expect.any(String), since: expect.any(String), expiresAt: expect.any(String) }])
  })

  it('says whether a code was behind the sign-in', async () => {
    const browser = new Browser(h.app)
    await signIn(browser, { ...WEB, email: 'anna.schmidt@example.com' })
    expect((await sessions(await userId('anna.schmidt@example.com'))).json().sessions[0].acr).toBe('urn:pforte:acr:mfa')
  })

  it('shows one session per browser', async () => {
    await signIn(new Browser(h.app), { ...WEB, email: 'felix.brandt@example.com' })
    await h.database.pool.query('delete from rate_limits')
    await h.database.pool.query('delete from otp_codes')
    await signIn(new Browser(h.app), { ...WEB, email: 'felix.brandt@example.com' })
    expect((await sessions(await userId('felix.brandt@example.com'))).json().sessions).toHaveLength(2)
  })

  it('never returns an identifier or a token, only what an administrator needs to see', async () => {
    await signIn(new Browser(h.app), { ...WEB, email: 'greta.lang@example.com' })
    const response = await sessions(await userId('greta.lang@example.com'))
    const stored = (await h.database.pool.query(`select id from oidc_payloads where account_id = $1`, [await userId('greta.lang@example.com')])).rows
    expect(stored.length).toBeGreaterThan(0)
    for (const { id } of stored) expect(response.body).not.toContain(id)
    expect(response.body).not.toMatch(/"(jti|uid|grantId|sid|id)"/)
  })

  it('is empty again once the sessions were ended', async () => {
    await signIn(new Browser(h.app), { ...WEB, email: 'hans.weber@example.com' })
    const id = await userId('hans.weber@example.com')
    expect((await sessions(id)).json().sessions).toHaveLength(1)
    await h.api('POST', `/users/${id}/end-sessions`)
    expect((await sessions(id)).json()).toEqual({ sessions: [], grants: [] })
  })

  it('does not show a session that has run out', async () => {
    await signIn(new Browser(h.app), { ...WEB, email: 'ben.keller@example.com' })
    const id = await userId('ben.keller@example.com')
    await h.database.pool.query(`update oidc_payloads set expires_at = now() - interval '1 minute' where account_id = $1`, [id])
    expect((await sessions(id)).json()).toEqual({ sessions: [], grants: [] })
  })

  it('does not show the sessions of somebody else', async () => {
    await signIn(new Browser(h.app), { ...WEB, email: 'anna.schmidt@example.com' })
    expect((await sessions(await userId('ben.keller@example.com'))).json().sessions).toEqual([])
  })

  it('is open to the directory scope, refused to nobody with a token, and answers 404 and 400 for bad ids', async () => {
    const id = await userId('ben.keller@example.com')
    expect((await sessions(id, h.directoryToken)).statusCode).toBe(200)
    expect((await h.api('GET', `/users/${id}/sessions`, { token: null })).statusCode).toBe(401)
    expect((await sessions('018f0000-0000-7000-8000-000000000000')).statusCode).toBe(404)
    expect((await sessions('not-an-id')).statusCode).toBe(400)
  })
})
