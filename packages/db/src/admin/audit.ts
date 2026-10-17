import { and, desc, eq, gte, like, lt } from 'drizzle-orm'
import type { DatabaseOrTransaction } from '../audit.js'
import { auditEvents } from '../schema/index.js'

export interface ListAuditEventsOptions {
  actorType?: (typeof auditEvents.$inferSelect)['actorType']
  actorId?: string
  /** An exact action such as `user.lock`, or a prefix with `*`, such as `user.*`. */
  action?: string
  targetType?: string
  targetId?: string
  /** Inclusive lower bound on the time of the event. */
  from?: Date
  /** Exclusive upper bound on the time of the event. */
  to?: Date
  /** Keyset paging, newest first: return events older than this id. */
  before?: string
  limit: number
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`)

/** Audit events, newest first. Ids are time-ordered, so paging is stable while new events arrive. */
export const listAuditEvents = async (db: DatabaseOrTransaction, options: ListAuditEventsOptions) => {
  const conditions = [
    options.actorType ? eq(auditEvents.actorType, options.actorType) : undefined,
    options.actorId ? eq(auditEvents.actorId, options.actorId) : undefined,
    options.action?.endsWith('*')
      ? like(auditEvents.action, `${escapeLike(options.action.slice(0, -1))}%`)
      : options.action
        ? eq(auditEvents.action, options.action)
        : undefined,
    options.targetType ? eq(auditEvents.targetType, options.targetType) : undefined,
    options.targetId ? eq(auditEvents.targetId, options.targetId) : undefined,
    options.from ? gte(auditEvents.createdAt, options.from) : undefined,
    options.to ? lt(auditEvents.createdAt, options.to) : undefined,
    options.before ? lt(auditEvents.id, options.before) : undefined,
  ]

  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(desc(auditEvents.id))
    .limit(options.limit + 1)

  const items = rows.slice(0, options.limit)
  return { items, nextCursor: rows.length > options.limit ? items.at(-1)?.id : undefined }
}
