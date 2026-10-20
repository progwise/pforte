import { and, eq, ne, sql } from 'drizzle-orm'
import type { DatabaseOrTransaction } from '../audit.js'
import { users } from '../schema/index.js'
import { AdminError } from './errors.js'
import type { RequestContext } from './users.js'

type UserRow = typeof users.$inferSelect

/**
 * Keeps somebody able to administer: refuses to lock, deactivate, delete or take the admin flag from the
 * last active administrator, and a person from doing any of these to themselves. Run it inside the transaction
 * that makes the change; it takes a lock so that two administrators cannot demote each other at the same moment.
 */
export const assertAdminStays = async (tx: DatabaseOrTransaction, context: RequestContext, user: UserRow, doing: string) => {
  if (!user.isAdmin) return
  if (context.actor.type === 'user' && context.actor.id === user.id) {
    throw new AdminError(`You cannot ${doing} yourself. Ask another administrator.`, 'conflict')
  }
  if (user.status !== 'active') return

  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('pforte:administrators', 0))`)
  const [others] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.isAdmin, true), eq(users.status, 'active'), ne(users.id, user.id)))
  if (others?.count === 0) {
    throw new AdminError(`You cannot ${doing} the last active administrator: nobody could administer pforte any more.`, 'conflict')
  }
}
