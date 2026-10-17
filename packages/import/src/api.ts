import { ImportFileError } from './errors.js'
import type { ClaimTypeInfo } from './columns.js'

export interface ApiUser {
  id: string
  email: string
  status: 'created' | 'active' | 'locked' | 'deactivated'
  isAdmin: boolean
}

export interface UpsertBody {
  firstName: string
  lastName: string
  phone?: string | null
  language?: string
  claims?: Record<string, string[]>
}

export interface Changes {
  profile: Record<string, { from: unknown; to: unknown }>
  claims: Record<string, { from: string[]; to: string[] }>
}

export interface UpsertResult {
  outcome: 'created' | 'updated' | 'unchanged'
  /** What changed (or would change, in a dry run). */
  changes?: Changes
}

/** What the import needs from the admin API. The HTTP client implements it; tests use a fake. */
export interface AdminApi {
  claimTypes(): Promise<ClaimTypeInfo[]>
  listUsers(): Promise<ApiUser[]>
  upsertUser(email: string, body: UpsertBody, options: { dryRun: boolean }): Promise<UpsertResult>
  lockUser(id: string): Promise<'locked' | 'skipped'>
  deleteUser(id: string): Promise<'deleted' | 'skipped'>
}

/** The API answered with an error that retrying will not fix. `problems` are the field errors of a 400. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly problems: { path: string; message: string }[] = [],
  ) {
    super(message)
  }
}

/** The API could not be reached, or kept failing, after the retries. */
export class ApiUnavailableError extends Error {}

export interface HttpApiOptions {
  baseUrl: string
  clientId: string
  clientSecret: string
  scope?: string
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** Waits between retries of a network error, a 429 or a 5xx answer. */
  retryDelaysMs?: number[]
  timeoutMs?: number
}

const RETRYABLE = (status: number) => status === 429 || status >= 500

/**
 * Talks to the admin API over HTTP with the client_credentials grant. The access token is fetched
 * when needed and renewed shortly before it expires, or when the API answers 401. Network errors,
 * 429 and 5xx answers are retried with growing pauses; other errors are returned at once.
 */
export const createHttpAdminApi = ({
  baseUrl,
  clientId,
  clientSecret,
  scope = 'directory',
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  retryDelaysMs = [200, 800, 2000],
  timeoutMs = 30_000,
}: HttpApiOptions): AdminApi => {
  const root = baseUrl.replace(/\/+$/, '')
  let token: { value: string; expiresAt: number } | undefined
  let pending: Promise<string> | undefined

  const fetchToken = async () => {
    const response = await fetchImpl(`${root}/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope }),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((error: Error) => {
      throw new ImportFileError(`Cannot reach ${root}: ${error.message}`)
    })
    if (!response.ok) {
      throw new ImportFileError(
        `Could not get an access token (HTTP ${response.status}). Check the address, the client id and the secret, and that the client may use the "${scope}" scope.`,
      )
    }
    const { access_token: value, expires_in: expiresIn = 600 } = (await response.json()) as { access_token: string; expires_in?: number }
    token = { value, expiresAt: Date.now() + expiresIn * 1000 }
    return value
  }

  /** One token at a time, even when many requests ask for it together. */
  const accessToken = async (renew = false) => {
    if (!renew && token && token.expiresAt - Date.now() > 30_000) return token.value
    pending ??= fetchToken().finally(() => {
      pending = undefined
    })
    return pending
  }

  const request = async <T>(method: string, path: string, body?: unknown): Promise<T | undefined> => {
    let renewed = false
    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await fetchImpl(`${root}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${await accessToken()}`,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        if (error instanceof ImportFileError) throw error
        const delay = retryDelaysMs[attempt]
        if (delay === undefined) throw new ApiUnavailableError(`Cannot reach the API: ${(error as Error).message}`)
        await sleep(delay)
        continue
      }

      if (response.status === 401 && !renewed) {
        renewed = true
        await accessToken(true)
        attempt--
        continue
      }
      if (RETRYABLE(response.status)) {
        const delay = retryDelaysMs[attempt]
        if (delay === undefined) throw new ApiUnavailableError(`The API keeps answering with HTTP ${response.status}.`)
        await sleep(delay)
        continue
      }
      if (response.status === 204) return undefined
      if (response.ok) return (await response.json()) as T

      const problem = (await response.json().catch(() => ({}))) as { title?: string; detail?: string; errors?: { path: string; message: string }[] }
      throw new ApiError(response.status, problem.detail ?? problem.title ?? `HTTP ${response.status}`, problem.errors ?? [])
    }
  }

  return {
    async claimTypes() {
      const result = await request<{ items: ClaimTypeInfo[] }>('GET', '/admin/claim-types')
      return result!.items.map(({ key, multiValued, valuePattern }) => ({ key, multiValued, valuePattern }))
    },

    async listUsers() {
      const users: ApiUser[] = []
      let cursor: string | undefined
      do {
        const page = await request<{ items: ApiUser[]; nextCursor?: string }>(
          'GET',
          `/admin/users?limit=200${cursor ? `&cursor=${cursor}` : ''}`,
        )
        users.push(...page!.items.map(({ id, email, status, isAdmin }) => ({ id, email, status, isAdmin })))
        cursor = page!.nextCursor
      } while (cursor)
      return users
    },

    async upsertUser(email, body, { dryRun }) {
      const result = await request<{ outcome: UpsertResult['outcome']; changes?: Changes }>(
        'PUT',
        `/admin/users/by-email/${encodeURIComponent(email)}${dryRun ? '?dryRun=true' : ''}`,
        body,
      )
      return { outcome: result!.outcome, changes: result!.changes }
    },

    async lockUser(id) {
      try {
        await request('POST', `/admin/users/${id}/lock`)
        return 'locked'
      } catch (error) {
        // Locked, deactivated or deleted in the meantime: nothing left to do.
        if (error instanceof ApiError && (error.status === 409 || error.status === 404)) return 'skipped'
        throw error
      }
    },

    async deleteUser(id) {
      try {
        await request('DELETE', `/admin/users/${id}`)
        return 'deleted'
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return 'skipped'
        throw error
      }
    },
  }
}
