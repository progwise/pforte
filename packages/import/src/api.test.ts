import { describe, expect, it } from 'vitest'
import { ApiError, ApiUnavailableError, createHttpAdminApi } from './api.js'
import { ImportFileError } from './errors.js'

type Call = { method: string; url: string; headers: Record<string, string>; body?: string }

/** A fetch that answers from a script, one answer per call, and records every call. */
const scripted = (answers: (Response | Error | ((call: Call) => Response))[]) => {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call = { method: init.method ?? 'GET', url, headers: init.headers as Record<string, string>, body: init.body as string | undefined }
    calls.push(call)
    const answer = answers.shift()
    if (answer === undefined) throw new Error(`unexpected call ${call.method} ${call.url}`)
    if (answer instanceof Error) throw answer
    return typeof answer === 'function' ? answer(call) : answer
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const token = (expiresIn = 3600, value = 'token-1') => json({ access_token: value, token_type: 'Bearer', expires_in: expiresIn })
const problem = (status: number, detail: string, errors?: unknown[]) => json({ type: 'about:blank', title: 'x', status, detail, ...(errors && { errors }) }, status)

const apiWith = (answers: Parameters<typeof scripted>[0], extra: Partial<Parameters<typeof createHttpAdminApi>[0]> = {}) => {
  const { fetchImpl, calls } = scripted(answers)
  const sleeps: number[] = []
  const api = createHttpAdminApi({
    baseUrl: 'https://id.example.com/',
    clientId: 'importer',
    clientSecret: 's3cret/+=',
    fetchImpl,
    sleep: async (ms) => void sleeps.push(ms),
    ...extra,
  })
  return { api, calls, sleeps }
}

describe('HTTP admin API client', () => {
  describe('access token', () => {
    it('asks for the directory scope with the client credentials, and reuses the token', async () => {
      const { api, calls } = apiWith([token(), json({ items: [] }), json({ items: [] })])

      await api.claimTypes()
      await api.claimTypes()

      expect(calls).toHaveLength(3)
      expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://id.example.com/token' })
      expect(calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from('importer:s3cret%2F%2B%3D').toString('base64')}`)
      expect(String(calls[0]!.body)).toContain('scope=directory')
      expect(calls[1]!.headers.authorization).toBe('Bearer token-1')
    })

    it('fetches a new token shortly before the old one expires', async () => {
      const { api, calls } = apiWith([token(20, 'short'), json({ items: [] }), token(3600, 'fresh'), json({ items: [] })])

      await api.claimTypes()
      await api.claimTypes()

      expect(calls[3]!.headers.authorization).toBe('Bearer fresh')
    })

    it('renews the token once when the API says 401, and carries on', async () => {
      const { api, calls } = apiWith([token(3600, 'old'), problem(401, 'expired'), token(3600, 'new'), json({ items: [] })])

      await api.claimTypes()

      expect(calls.map((call) => call.headers.authorization)).toEqual([expect.stringMatching(/^Basic/), 'Bearer old', expect.stringMatching(/^Basic/), 'Bearer new'])
    })

    it('does not loop when the API keeps saying 401', async () => {
      const { api } = apiWith([token(), problem(401, 'no'), token(), problem(401, 'still no')])

      await expect(api.claimTypes()).rejects.toMatchObject({ status: 401 })
    })

    it('fetches one token for many requests that start together', async () => {
      const { api, calls } = apiWith([token(), json({ items: [] }), json({ items: [] }), json({ items: [] })])

      await Promise.all([api.claimTypes(), api.claimTypes(), api.claimTypes()])

      expect(calls.filter((call) => call.url.endsWith('/token'))).toHaveLength(1)
    })

    it('explains a refused token and an unreachable server', async () => {
      await expect(apiWith([json({ error: 'invalid_client' }, 401)]).api.claimTypes()).rejects.toThrow(/Could not get an access token \(HTTP 401\).*"directory" scope/)
      await expect(apiWith([new Error('ECONNREFUSED')]).api.claimTypes()).rejects.toThrow(/Cannot reach https:\/\/id\.example\.com: ECONNREFUSED/)
      await expect(apiWith([json({}, 401)]).api.claimTypes()).rejects.toBeInstanceOf(ImportFileError)
    })
  })

  describe('retrying', () => {
    it('retries a 503 with growing pauses and then succeeds', async () => {
      const { api, sleeps } = apiWith([token(), problem(503, 'busy'), problem(502, 'bad gateway'), json({ items: [] })])

      await expect(api.claimTypes()).resolves.toEqual([])
      expect(sleeps).toEqual([200, 800])
    })

    it('retries network errors and 429', async () => {
      const { api, sleeps } = apiWith([token(), new Error('socket hang up'), problem(429, 'slow down'), json({ items: [] })])

      await expect(api.claimTypes()).resolves.toEqual([])
      expect(sleeps).toHaveLength(2)
    })

    it('gives up after the last pause and says the API is unavailable', async () => {
      const { api, sleeps } = apiWith([token(), problem(503, 'a'), problem(503, 'b'), problem(503, 'c'), problem(503, 'd')])

      await expect(api.claimTypes()).rejects.toBeInstanceOf(ApiUnavailableError)
      expect(sleeps).toEqual([200, 800, 2000])
    })

    it('does not retry an error the caller must fix', async () => {
      const { api, calls, sleeps } = apiWith([
        token(),
        problem(400, 'The request does not match the schema.', [{ path: '/claims/partner_no', message: 'bad value' }]),
      ])

      const error = await api.upsertUser('a@example.com', { firstName: 'A', lastName: 'B' }, { dryRun: false }).catch((e: ApiError) => e)

      expect(error).toBeInstanceOf(ApiError)
      expect(error).toMatchObject({ status: 400, problems: [{ path: '/claims/partner_no', message: 'bad value' }] })
      expect(calls).toHaveLength(2)
      expect(sleeps).toEqual([])
    })
  })

  describe('requests', () => {
    it('upserts by e-mail with the e-mail encoded, the body as JSON and an optional dry run', async () => {
      const { api, calls } = apiWith([
        token(),
        json({ dryRun: false, outcome: 'created', user: {}, claims: {} }, 201),
        json({ dryRun: true, outcome: 'updated', changes: { profile: { lastName: { from: 'A', to: 'B' } }, claims: {} } }),
      ])
      const body = { firstName: 'Ann', lastName: 'Lee', phone: null, claims: { partner_no: ['00001'] } }

      const created = await api.upsertUser('ann+test@example.com', body, { dryRun: false })
      const dry = await api.upsertUser('ann@example.com', body, { dryRun: true })

      expect(created).toEqual({ outcome: 'created', changes: undefined })
      expect(dry.changes?.profile).toEqual({ lastName: { from: 'A', to: 'B' } })
      expect(calls[1]).toMatchObject({ method: 'PUT', url: 'https://id.example.com/admin/users/by-email/ann%2Btest%40example.com' })
      expect(JSON.parse(calls[1]!.body!)).toEqual(body)
      expect(calls[2]!.url).toBe('https://id.example.com/admin/users/by-email/ann%40example.com?dryRun=true')
    })

    it('lists all users, following the cursor', async () => {
      const user = (n: number) => ({ id: `id${n}`, email: `u${n}@example.com`, status: 'active', isAdmin: false, firstName: 'x' })
      const { api, calls } = apiWith([token(), json({ items: [user(1), user(2)], nextCursor: 'c1' }), json({ items: [user(3)] })])

      const users = await api.listUsers()

      expect(users.map((u) => u.email)).toEqual(['u1@example.com', 'u2@example.com', 'u3@example.com'])
      expect(users[0]).toEqual({ id: 'id1', email: 'u1@example.com', status: 'active', isAdmin: false })
      expect(calls[1]!.url).toBe('https://id.example.com/admin/users?limit=200')
      expect(calls[2]!.url).toBe('https://id.example.com/admin/users?limit=200&cursor=c1')
    })

    it('treats a user who is already locked or gone as skipped', async () => {
      const { api } = apiWith([token(), json({}), problem(409, 'already locked'), problem(404, 'gone'), new Response(null, { status: 204 }), problem(404, 'gone')])

      expect(await api.lockUser('a')).toBe('locked')
      expect(await api.lockUser('b')).toBe('skipped')
      expect(await api.lockUser('c')).toBe('skipped')
      expect(await api.deleteUser('d')).toBe('deleted')
      expect(await api.deleteUser('e')).toBe('skipped')
    })
  })
})
