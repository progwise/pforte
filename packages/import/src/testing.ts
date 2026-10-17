import { type AdminApi, type ApiUser, ApiError, ApiUnavailableError, type UpsertBody } from './api.js'
import type { ClaimTypeInfo } from './columns.js'

interface StoredUser {
  id: string
  email: string
  firstName: string
  lastName: string
  phone: string | null
  language: string
  status: ApiUser['status']
  isAdmin: boolean
  claims: Record<string, string[]>
}

export const fakeClaimTypes: ClaimTypeInfo[] = [
  { key: 'partner_no', multiValued: true, valuePattern: '^[0-9]{5}$' },
  { key: 'customer_no', multiValued: false, valuePattern: null },
]

/** An in-memory admin API that behaves like the real one: it diffs, rejects bad values and can fail on demand. */
export class FakeApi implements AdminApi {
  users = new Map<string, StoredUser>()
  calls = { claimTypes: 0, list: 0, upsert: 0, lock: 0, delete: 0 }
  bodies: UpsertBody[] = []
  /** Emails whose upsert fails as if the network broke. */
  unreachable = new Set<string>()
  /** Emails the server rejects with a 400 although the file's rules passed. */
  serverRejects = new Set<string>()
  /** HTTP status to answer every upsert with, e.g. 403. */
  refuseWith?: number
  inFlight = 0
  maxInFlight = 0
  private counter = 0

  seed(email: string, extra: Partial<StoredUser> = {}) {
    this.users.set(email, { id: `id-${++this.counter}`, email, firstName: 'Old', lastName: 'Name', phone: null, language: 'en', status: 'active', isAdmin: false, claims: {}, ...extra })
    return this.users.get(email)!
  }

  async claimTypes() {
    this.calls.claimTypes++
    return fakeClaimTypes
  }

  async listUsers() {
    this.calls.list++
    return [...this.users.values()].map(({ id, email, status, isAdmin }) => ({ id, email, status, isAdmin }))
  }

  async upsertUser(email: string, body: UpsertBody, { dryRun }: { dryRun: boolean }) {
    this.calls.upsert++
    this.bodies.push(body)
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      await new Promise((resolve) => setTimeout(resolve, 1))
      if (this.refuseWith) throw new ApiError(this.refuseWith, 'Only the directory scope may do this.')
      if (this.unreachable.has(email)) throw new ApiUnavailableError('Cannot reach the API: socket hang up')
      if (this.serverRejects.has(email)) throw new ApiError(400, 'The request does not match the schema.', [{ path: '/claims/partner_no', message: 'the server says no' }])

      const existing = this.users.get(email)
      const next = {
        firstName: body.firstName,
        lastName: body.lastName,
        phone: body.phone !== undefined ? body.phone : (existing?.phone ?? null),
        language: body.language ?? existing?.language ?? 'en',
        claims: { ...existing?.claims, ...body.claims },
      }
      for (const [type, values] of Object.entries(next.claims)) if (values.length === 0) delete next.claims[type]

      const profile: Record<string, { from: unknown; to: unknown }> = {}
      if (existing) for (const field of ['firstName', 'lastName', 'phone', 'language'] as const) if (existing[field] !== next[field]) profile[field] = { from: existing[field], to: next[field] }
      const claims: Record<string, { from: string[]; to: string[] }> = {}
      for (const type of Object.keys(body.claims ?? {})) {
        const from = existing?.claims[type] ?? []
        const to = next.claims[type] ?? []
        if (JSON.stringify([...from].sort()) !== JSON.stringify([...to].sort())) claims[type] = { from, to }
      }
      const outcome = !existing ? 'created' : Object.keys(profile).length + Object.keys(claims).length > 0 ? 'updated' : 'unchanged'

      if (!dryRun && outcome !== 'unchanged') {
        if (existing) Object.assign(existing, next)
        else this.seed(email, { ...next, status: 'created' })
      }
      return { outcome, changes: { profile, claims } } as const
    } finally {
      this.inFlight--
    }
  }

  async lockUser(id: string) {
    this.calls.lock++
    const user = [...this.users.values()].find((candidate) => candidate.id === id)!
    user.status = 'locked'
    return 'locked' as const
  }

  async deleteUser(id: string) {
    this.calls.delete++
    const user = [...this.users.values()].find((candidate) => candidate.id === id)!
    this.users.delete(user.email)
    return 'deleted' as const
  }
}

