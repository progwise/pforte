import { randomBytes } from 'node:crypto'

/** What was asked for when the file was checked, so that importing it does exactly that. */
export interface ImportSettings {
  encoding: 'utf-8' | 'windows-1252'
  valueSeparator: string
  ignoreUnknownColumns: boolean
  missing: 'ignore' | 'lock' | 'delete'
  allowDelete: boolean
  maxMissingPercent: number
}

export interface StoredImport {
  userId: string
  /** The file, kept until it is imported (or forgotten). */
  bytes?: Uint8Array
  settings: ImportSettings
  /** The rejected rows of the last run, ready to download. */
  rejectedCsv?: string
}

export const IMPORT_TTL_MS = 30 * 60_000

/**
 * The uploads of the administrators, in memory only. A file is kept for 30 minutes so that "Import now" works on what was
 * just checked; each person has at most one, so memory is bounded by the number of administrators times the upload limit.
 * Nothing is written to disk: the file holds personal data.
 */
export const createImportStore = ({ ttlMs = IMPORT_TTL_MS, now = Date.now }: { ttlMs?: number; now?: () => number } = {}) => {
  const entries = new Map<string, StoredImport & { expiresAt: number }>()
  const tokenOf = new Map<string, string>()

  const sweep = () => {
    for (const [token, entry] of entries) {
      if (entry.expiresAt <= now()) {
        entries.delete(token)
        if (tokenOf.get(entry.userId) === token) tokenOf.delete(entry.userId)
      }
    }
  }

  return {
    /** Keeps an upload for the person, replacing the one they had before. Returns the token that names it. */
    put(entry: StoredImport) {
      sweep()
      const earlier = tokenOf.get(entry.userId)
      if (earlier) entries.delete(earlier)
      const token = randomBytes(24).toString('base64url')
      entries.set(token, { ...entry, expiresAt: now() + ttlMs })
      tokenOf.set(entry.userId, token)
      return token
    },

    /** The upload, if it is the person's own and still kept. */
    get(token: string, userId: string) {
      sweep()
      const entry = entries.get(token)
      return entry?.userId === userId ? entry : undefined
    },

    /** The file is no longer needed (it was imported); what is left to download stays. */
    release(token: string, rejectedCsv?: string) {
      const entry = entries.get(token)
      if (!entry) return
      entry.bytes = undefined
      entry.rejectedCsv = rejectedCsv
    },

    setRejectedCsv(token: string, rejectedCsv: string | undefined) {
      const entry = entries.get(token)
      if (entry) entry.rejectedCsv = rejectedCsv
    },

    clear() {
      entries.clear()
      tokenOf.clear()
    },

    sweep,
    size: () => entries.size,
  }
}

export type ImportStore = ReturnType<typeof createImportStore>
