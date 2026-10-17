import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm'
import type { Database } from './index.js'
import { devices } from './schema/index.js'

/** How long a remembered device skips the second factor. */
export const DEVICE_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** Remembers a device after the user passed the second factor. The token goes into a cookie; only its hash is stored. */
export const rememberDevice = async (
  db: Database,
  { userId, userAgent }: { userId: string; userAgent?: string },
  now = new Date(),
) => {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(now.getTime() + DEVICE_LIFETIME_MS)
  await db.insert(devices).values({
    userId,
    tokenHash: hashToken(token),
    userAgent: userAgent?.slice(0, 300),
    lastSeenAt: now,
    expiresAt,
  })
  return { token, expiresAt }
}

/**
 * Whether one of the tokens (a browser may hold several, one per person who signed in there)
 * belongs to a device of this user that is neither revoked nor expired. Notes the visit.
 */
export const findRememberedDevice = async (db: Database, userId: string, tokens: string[], now = new Date()) => {
  if (tokens.length === 0) return undefined
  const [device] = await db
    .update(devices)
    .set({ lastSeenAt: now })
    .where(
      and(
        eq(devices.userId, userId),
        inArray(devices.tokenHash, tokens.map(hashToken)),
        isNull(devices.revokedAt),
        gt(devices.expiresAt, now),
      ),
    )
    .returning({ id: devices.id })
  return device
}

/** Deletes devices that expired or were revoked more than a month ago. Returns how many. */
export const deleteOldDevices = async (db: Database, now = new Date()) => {
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const deleted = await db
    .delete(devices)
    .where(or(lt(devices.expiresAt, cutoff), lt(devices.revokedAt, cutoff)))
    .returning({ id: devices.id })
  return deleted.length
}
