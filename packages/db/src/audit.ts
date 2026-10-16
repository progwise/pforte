import type { Database } from './index.js'
import { auditEvents } from './schema/index.js'

/** A transaction handle from `db.transaction`. It offers the same queries as the database. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
export type DatabaseOrTransaction = Database | Transaction

export interface AuditEventInput {
  actor: { type: 'user' | 'client' | 'system'; id?: string }
  /** Dotted action name, e.g. `user.create`. */
  action: string
  target?: { type: string; id: string }
  /** Anything worth knowing later. Include a snapshot such as the e-mail, so the event survives a delete. */
  details?: Record<string, unknown>
  ip?: string
  userAgent?: string
}

/**
 * Appends an audit event. Call it inside the same transaction as the change it describes, so a
 * change is either recorded together with its event or not applied at all.
 */
export const recordAuditEvent = async (db: DatabaseOrTransaction, event: AuditEventInput) => {
  await db.insert(auditEvents).values({
    actorType: event.actor.type,
    actorId: event.actor.id,
    action: event.action,
    targetType: event.target?.type,
    targetId: event.target?.id,
    details: event.details ?? {},
    ip: event.ip,
    userAgent: event.userAgent,
  })
}
