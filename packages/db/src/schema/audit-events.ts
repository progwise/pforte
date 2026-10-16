import { index, inet, jsonb, pgEnum, pgTable, text } from 'drizzle-orm/pg-core'
import { createdAt, id } from './columns.js'

export const auditActorType = pgEnum('audit_actor_type', ['user', 'client', 'system'])

/**
 * Append-only log of administrative actions and logins. Deliberately has no foreign keys
 * and no updated_at, so events survive deleting users and are never modified.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    actorType: auditActorType().notNull(),
    actorId: text(),
    action: text().notNull(),
    targetType: text(),
    targetId: text(),
    /** Free-form details, including a snapshot such as the target's e-mail. */
    details: jsonb().notNull().default({}),
    ip: inet(),
    userAgent: text(),
    createdAt: createdAt(),
  },
  (table) => [
    index('audit_events_created_at').on(table.createdAt),
    index('audit_events_target').on(table.targetType, table.targetId),
    index('audit_events_actor').on(table.actorType, table.actorId),
    index('audit_events_action').on(table.action),
  ],
)
