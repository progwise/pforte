import { and, count, desc, eq } from 'drizzle-orm'
import { type DatabaseOrTransaction, recordAuditEvent } from '../audit.js'
import { passkeys, type users } from '../schema/index.js'
import type { RequestContext } from './users.js'

type UserRow = typeof users.$inferSelect

/** How many passkeys one person may have. More than anybody needs; it keeps the list a device is asked about short. */
export const MAX_PASSKEYS = 20

const audit = (context: RequestContext, action: string, user: UserRow, details: Record<string, unknown>) => ({
  actor: context.actor,
  ip: context.ip,
  userAgent: context.userAgent,
  action,
  target: { type: 'user', id: user.id },
  details: { email: user.email, ...details, ...(context.self ? { self: true } : {}) },
})

/** The passkeys of a user, newest first. */
export const listPasskeys = (db: DatabaseOrTransaction, userId: string) =>
  db
    .select({
      id: passkeys.id,
      credentialId: passkeys.credentialId,
      transports: passkeys.transports,
      synced: passkeys.synced,
      label: passkeys.label,
      createdAt: passkeys.createdAt,
      lastUsedAt: passkeys.lastUsedAt,
    })
    .from(passkeys)
    .where(eq(passkeys.userId, userId))
    .orderBy(desc(passkeys.createdAt), desc(passkeys.id))

export interface NewPasskey {
  credentialId: string
  publicKey: string
  counter: number
  transports: string[]
  synced: boolean
  label?: string
}

/**
 * Stores a passkey the person's device has just created. `duplicate` if the credential is known already (to this
 * person or to anybody else), `too-many` if the person has `MAX_PASSKEYS`.
 */
export const addPasskey = async (tx: DatabaseOrTransaction, context: RequestContext, user: UserRow, passkey: NewPasskey) => {
  const [existing] = await tx.select({ count: count() }).from(passkeys).where(eq(passkeys.userId, user.id))
  if ((existing?.count ?? 0) >= MAX_PASSKEYS) return { kind: 'too-many' } as const

  const [added] = await tx
    .insert(passkeys)
    .values({ userId: user.id, ...passkey, label: passkey.label?.slice(0, 100) })
    .onConflictDoNothing({ target: passkeys.credentialId })
    .returning({ id: passkeys.id, label: passkeys.label })
  if (!added) return { kind: 'duplicate' } as const
  await recordAuditEvent(tx, audit(context, 'user.passkey.add', user, { passkeyId: added.id, label: added.label, synced: passkey.synced }))
  return { kind: 'added', id: added.id, label: added.label } as const
}

/** Removes one passkey: it cannot sign in any more. Returns false if the user has no such passkey. */
export const removePasskey = async (tx: DatabaseOrTransaction, context: RequestContext, user: UserRow, passkeyId: string) => {
  const [removed] = await tx
    .delete(passkeys)
    .where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, user.id)))
    .returning({ id: passkeys.id, label: passkeys.label })
  if (!removed) return false
  await recordAuditEvent(tx, audit(context, 'user.passkey.remove', user, { passkeyId, label: removed.label }))
  return true
}
