import { and, desc, eq, gte, inArray, like, lt, or, sql } from 'drizzle-orm'
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

/**
 * The newest sign-in events about one user, for that user to look at: that somebody got in, or was turned away at
 * the sign-in. Only events that name the user as the target.
 *
 * `login.code_failed` and `login.blocked` are also written by the password reset, the activation and the
 * confirmation of a phone number. Those are not sign-ins and are left out here, in the query and not afterwards,
 * so that they cannot push sign-ins out of the newest few. Codes that were sent are not listed either.
 */
export const listSignInEvents = async (db: DatabaseOrTransaction, userId: string, limit: number) =>
  db
    .select({ id: auditEvents.id, action: auditEvents.action, details: auditEvents.details, ip: auditEvents.ip, userAgent: auditEvents.userAgent, createdAt: auditEvents.createdAt })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.targetType, 'user'),
        eq(auditEvents.targetId, userId),
        or(
          inArray(auditEvents.action, ['login.succeeded', 'login.password_failed']),
          and(eq(auditEvents.action, 'login.code_failed'), sql`${auditEvents.details}->>'purpose' = 'login'`),
          and(eq(auditEvents.action, 'login.blocked'), sql`${auditEvents.details}->>'scope' in ('password', 'code', 'code_resend')`),
        ),
      ),
    )
    .orderBy(desc(auditEvents.id))
    .limit(limit)
