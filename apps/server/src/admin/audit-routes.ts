import type { Database } from '@progwise/pforte-db'
import { listAuditEvents } from '@progwise/pforte-db/admin'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { AdminAuth } from './auth.js'
import { problemSchema } from './problem.js'

const auditEventSchema = z.object({
  id: z.uuid(),
  createdAt: z.string(),
  actorType: z.enum(['user', 'client', 'system']),
  actorId: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  /** What changed, with a snapshot such as the e-mail of a user, so the event stays readable after a delete. */
  details: z.record(z.string(), z.unknown()),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
})

const datetime = z.iso.datetime().transform((value) => new Date(value))

/** The audit log: who did what, when and to whom. Admin scope only, as it holds e-mails and addresses. */
export const auditRoutes =
  ({ db, auth }: { db: Database; auth: AdminAuth }) =>
  async (instance: FastifyInstance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>()

    app.get(
      '/audit-events',
      {
        onRequest: auth.require('admin'),
        schema: {
          tags: ['Audit'],
          summary: 'List audit events',
          description:
            'Newest first. Every change through the admin API and every lifecycle action is recorded with the client that ' +
            'made it. Pass `nextCursor` as `cursor` to get older events; the order is stable while new events arrive.',
          querystring: z.object({
            actorType: z.enum(['user', 'client', 'system']).optional(),
            actorId: z.string().min(1).optional(),
            action: z
              .string()
              .min(1)
              .optional()
              .describe('An exact action such as `user.lock`, or a prefix ending in `*` such as `user.*`.'),
            targetType: z.string().min(1).optional(),
            targetId: z.string().min(1).optional(),
            from: datetime.optional().describe('Only events at or after this time (ISO 8601).'),
            to: datetime.optional().describe('Only events before this time (ISO 8601).'),
            cursor: z.uuid().optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
          }),
          response: {
            200: z.object({ items: z.array(auditEventSchema), nextCursor: z.uuid().optional() }),
            400: problemSchema,
            401: problemSchema,
            403: problemSchema,
          },
        },
      },
      async (request) => {
        const { cursor, ...filters } = request.query
        const { items, nextCursor } = await listAuditEvents(db, { ...filters, before: cursor })
        return {
          items: items.map((event) => ({
            id: event.id,
            createdAt: event.createdAt.toISOString(),
            actorType: event.actorType,
            actorId: event.actorId,
            action: event.action,
            targetType: event.targetType,
            targetId: event.targetId,
            details: event.details as Record<string, unknown>,
            ip: event.ip,
            userAgent: event.userAgent,
          })),
          nextCursor,
        }
      },
    )
  }
