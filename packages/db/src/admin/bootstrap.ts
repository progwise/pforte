import { count, eq, sql } from 'drizzle-orm'
import type { Database } from '../index.js'
import { users } from '../schema/index.js'
import { activateUser } from './lifecycle.js'
import { createUser, findUserByEmail, type RequestContext, updateUser } from './users.js'

type UserRow = typeof users.$inferSelect

export type BootstrapResult =
  | { outcome: 'exists' }
  | { outcome: 'created' | 'promoted'; user: UserRow; activation?: { token: string; expiresAt: Date } }

const context: RequestContext = { actor: { type: 'system' }, userAgent: 'bootstrap' }

/**
 * Makes sure somebody can administer pforte: if there is no administrator at all, the user with this address becomes
 * one, created first if need be, and gets an activation link to choose a password. With an administrator in place
 * nothing happens, so this can run at every start.
 *
 * `deliver` sends the link and runs before the change is committed: if it cannot be sent, nothing is changed and the
 * next start tries again. Otherwise the link would be lost with nobody left to ask for another.
 */
export const ensureAdministrator = (
  db: Database,
  email: string,
  deliver: (user: UserRow, activation: { token: string; expiresAt: Date }) => Promise<void>,
): Promise<BootstrapResult> =>
  db.transaction(async (tx) => {
    // The same lock the rule "the last administrator stays" takes, and for the same reason: starts at the same moment.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('pforte:administrators', 0))`)
    const [admins] = await tx.select({ count: count() }).from(users).where(eq(users.isAdmin, true))
    if ((admins?.count ?? 0) > 0) return { outcome: 'exists' as const }

    const existing = await findUserByEmail(tx, email)
    let user = existing
      ? (await updateUser(tx, context, existing, { isAdmin: true })).user
      : await createUser(tx, context, { email: email.trim().toLowerCase(), firstName: 'Administrator', lastName: 'pforte', isAdmin: true })

    let activation: { token: string; expiresAt: Date } | undefined
    if (user.status === 'created') {
      const started = await activateUser(tx, context, user)
      user = started.user
      activation = started.activation
      if (activation) await deliver(user, activation)
    }
    return { outcome: existing ? ('promoted' as const) : ('created' as const), user, activation }
  })
