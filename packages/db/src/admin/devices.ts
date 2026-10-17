import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import { type DatabaseOrTransaction, recordAuditEvent } from '../audit.js'
import { devices, type users } from '../schema/index.js'
import type { RequestContext } from './users.js'

type UserRow = typeof users.$inferSelect

const audit = (context: RequestContext, action: string, user: UserRow, details: Record<string, unknown>) => ({
  actor: context.actor,
  ip: context.ip,
  userAgent: context.userAgent,
  action,
  target: { type: 'user', id: user.id },
  details: { email: user.email, ...details },
})

const active = (userId: string, now: Date) =>
  and(eq(devices.userId, userId), isNull(devices.revokedAt), gt(devices.expiresAt, now))

/** The devices of a user that still skip the second factor, most recently seen first. */
export const listDevices = (db: DatabaseOrTransaction, userId: string, now = new Date()) =>
  db
    .select({
      id: devices.id,
      userAgent: devices.userAgent,
      createdAt: devices.createdAt,
      lastSeenAt: devices.lastSeenAt,
      expiresAt: devices.expiresAt,
    })
    .from(devices)
    .where(active(userId, now))
    .orderBy(desc(devices.lastSeenAt))

/** Revokes one device. Returns false if the user has no such active device. */
export const revokeDevice = async (tx: DatabaseOrTransaction, context: RequestContext, user: UserRow, deviceId: string) => {
  const [revoked] = await tx
    .update(devices)
    .set({ revokedAt: new Date() })
    .where(and(eq(devices.id, deviceId), active(user.id, new Date())))
    .returning({ id: devices.id, userAgent: devices.userAgent })
  if (!revoked) return false
  await recordAuditEvent(tx, audit(context, 'user.device.revoke', user, { deviceId, userAgent: revoked.userAgent }))
  return true
}

/** Revokes every device of a user, so the next sign-in asks for the code again. Returns how many. */
export const revokeAllDevices = async (tx: DatabaseOrTransaction, context: RequestContext, user: UserRow) => {
  const count = await revokeUserDevices(tx, user.id)
  await recordAuditEvent(tx, audit(context, 'user.devices.revoke', user, { devicesRevoked: count }))
  return count
}

/** Revokes the devices without an audit event of its own, for actions that record one themselves. */
export const revokeUserDevices = async (tx: DatabaseOrTransaction, userId: string) => {
  const revoked = await tx
    .update(devices)
    .set({ revokedAt: new Date() })
    .where(active(userId, new Date()))
    .returning({ id: devices.id })
  return revoked.length
}
