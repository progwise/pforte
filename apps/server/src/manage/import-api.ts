import { type AdminApi, ApiError, type ApiUser, type Changes, type ClaimTypeInfo, type UpsertResult } from '@progwise/pforte-import'
import type { ApiCall } from './api.js'

type Caller = (call: ApiCall) => Promise<{ statusCode: number; json: () => unknown }>

/**
 * What the import library needs from the admin API, answered by the API of this very process, as the person who
 * is signed in. The import therefore obeys the rules of the API and is recorded in the audit log under that person's
 * name, like every other change made in the administration.
 */
export const createInProcessAdminApi = (call: Caller): AdminApi & { sessionEnded: () => boolean } => {
  let ended = false

  const request = async <T>(method: ApiCall['method'], url: string, body?: unknown): Promise<T | undefined> => {
    const response = await call({ method, url, body })
    if (response.statusCode === 401) ended = true
    if (response.statusCode === 204) return undefined
    if (response.statusCode < 400) return response.json() as T

    let problem: { title?: string; detail?: string; errors?: { path: string; message: string }[] } = {}
    try {
      problem = response.json() as typeof problem
    } catch {
      // not JSON: the status says enough
    }
    throw new ApiError(response.statusCode, problem.detail ?? problem.title ?? `HTTP ${response.statusCode}`, problem.errors ?? [])
  }

  return {
    /** The API said the person's session is over: the page must send them to sign in again. */
    sessionEnded: () => ended,

    async claimTypes() {
      const result = await request<{ items: (ClaimTypeInfo & { description?: string })[] }>('GET', '/claim-types')
      return result!.items.map(({ key, multiValued, valuePattern }) => ({ key, multiValued, valuePattern }))
    },

    async listUsers() {
      const users: ApiUser[] = []
      let cursor: string | undefined
      do {
        const page = await request<{ items: ApiUser[]; nextCursor?: string }>('GET', `/users?limit=200${cursor ? `&cursor=${cursor}` : ''}`)
        users.push(...page!.items.map(({ id, email, status, isAdmin }) => ({ id, email, status, isAdmin })))
        cursor = page!.nextCursor
      } while (cursor)
      return users
    },

    async upsertUser(email, body, { dryRun }) {
      const result = await request<{ outcome: UpsertResult['outcome']; changes?: Changes }>('PUT', `/users/by-email/${encodeURIComponent(email)}${dryRun ? '?dryRun=true' : ''}`, body)
      return { outcome: result!.outcome, changes: result!.changes }
    },

    async lockUser(id) {
      try {
        await request('POST', `/users/${id}/lock`)
        return 'locked'
      } catch (error) {
        // Locked, deactivated or deleted in the meantime: nothing left to do.
        if (error instanceof ApiError && (error.status === 409 || error.status === 404)) return 'skipped'
        throw error
      }
    },

    async deleteUser(id) {
      try {
        await request('DELETE', `/users/${id}`)
        return 'deleted'
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return 'skipped'
        throw error
      }
    },
  }
}
