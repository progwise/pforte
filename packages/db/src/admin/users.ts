import { and, asc, eq, exists, gt, ilike, or, sql } from 'drizzle-orm'
import { type AuditEventInput, type DatabaseOrTransaction, recordAuditEvent } from '../audit.js'
import { withdrawCodeUnlessHeld } from '../codes.js'
import { userClaims, users } from '../schema/index.js'
import { assertAdminStays } from './admins.js'
import { endUserSessions } from './lifecycle.js'

type UserRow = typeof users.$inferSelect

/** The fields an administrator may set. Passwords, status and tokens are managed elsewhere. */
export interface UserProfile {
  email: string
  firstName: string
  lastName: string
  phone: string | null
  language: string
  isAdmin: boolean
}

export const findUserById = async (db: DatabaseOrTransaction, id: string) => {
  const [user] = await db.select().from(users).where(eq(users.id, id))
  return user
}

export const findUserByEmail = async (db: DatabaseOrTransaction, email: string) => {
  const [user] = await db.select().from(users).where(eq(users.email, email))
  return user
}

/**
 * The user with this address, with their row held until the transaction ends. For a change that is decided by
 * what the row says: whatever else changes the person has finished before this read, or waits for this
 * transaction. Without it the decision could be made on a row that is no longer true when it is written, such as
 * a number the person made their own in between (`changePhone`).
 *
 * `no key update`, as `confirmPhone` takes it and for the reason given there: a new code refers to the row and
 * must not wait for it.
 */
export const findUserByEmailForChange = async (tx: DatabaseOrTransaction, email: string) => {
  const [user] = await tx.select().from(users).where(eq(users.email, email)).for('no key update')
  return user
}

export interface ListUsersOptions {
  /** Matches e-mail, first name or last name, case-insensitively. */
  search?: string
  status?: UserRow['status']
  /** Only users holding this claim value. */
  claim?: { type: string; value: string }
  /** Keyset paging: ids are time-ordered, so this is stable while users are added. */
  after?: string
  limit: number
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`)

export const listUsers = async (db: DatabaseOrTransaction, options: ListUsersOptions) => {
  const conditions = [
    options.after ? gt(users.id, options.after) : undefined,
    options.status ? eq(users.status, options.status) : undefined,
    options.search
      ? or(
          ilike(users.email, `%${escapeLike(options.search)}%`),
          ilike(users.firstName, `%${escapeLike(options.search)}%`),
          ilike(users.lastName, `%${escapeLike(options.search)}%`),
        )
      : undefined,
    options.claim
      ? exists(
          db
            .select({ one: sql`1` })
            .from(userClaims)
            .where(
              and(
                eq(userClaims.userId, users.id),
                eq(userClaims.claimTypeKey, options.claim.type),
                eq(userClaims.value, options.claim.value),
              ),
            ),
        )
      : undefined,
  ]

  // One row more than asked for tells whether another page follows.
  const rows = await db
    .select()
    .from(users)
    .where(and(...conditions))
    .orderBy(asc(users.id))
    .limit(options.limit + 1)

  const items = rows.slice(0, options.limit)
  return { items, nextCursor: rows.length > options.limit ? items.at(-1)?.id : undefined }
}

export interface Actor {
  type: 'client' | 'user' | 'system'
  id?: string
}

export interface RequestContext {
  actor: Actor
  ip?: string
  userAgent?: string
  /**
   * The person acts on their own account, on the account pages. The audit event then says `self: true`, so an
   * administrator can tell it from the same action done by the back office.
   */
  self?: boolean
}

const audit = (context: RequestContext, event: Pick<AuditEventInput, 'action' | 'target' | 'details'>) => ({
  ...event,
  actor: context.actor,
  ip: context.ip,
  userAgent: context.userAgent,
})

const PROFILE_FIELDS = ['email', 'firstName', 'lastName', 'phone', 'language', 'isAdmin'] as const

/** What differs between a user and the wanted profile, as `{ field: { from, to } }`. */
export const profileChanges = (user: UserRow, wanted: Partial<UserProfile>) => {
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const field of PROFILE_FIELDS) {
    const to = wanted[field]
    if (to !== undefined && to !== user[field]) {
      changes[field] = { from: user[field], to }
    }
  }
  return changes
}

/** Creates a user in status `created`. Run inside a transaction, together with its audit event. */
export const createUser = async (
  tx: DatabaseOrTransaction,
  context: RequestContext,
  profile: Pick<UserProfile, 'email' | 'firstName' | 'lastName'> & Partial<UserProfile>,
) => {
  const [user] = await tx.insert(users).values(profile).returning()
  await recordAuditEvent(
    tx,
    audit(context, {
      action: 'user.create',
      target: { type: 'user', id: user!.id },
      details: { email: user!.email, firstName: user!.firstName, lastName: user!.lastName },
    }),
  )
  return user!
}

/** Applies a profile change. Returns the user unchanged, and writes nothing, when nothing differs. */
export const updateUser = async (
  tx: DatabaseOrTransaction,
  context: RequestContext,
  user: UserRow,
  wanted: Partial<UserProfile>,
) => {
  const changes = profileChanges(user, wanted)
  if (Object.keys(changes).length === 0) {
    return { user, changed: false as const, changes }
  }

  if (changes.isAdmin && changes.isAdmin.to === false) await assertAdminStays(tx, context, user, 'take the admin right from')
  const values: Record<string, unknown> = Object.fromEntries(Object.entries(changes).map(([field, { to }]) => [field, to]))
  // A confirmation belongs to the address or number that was confirmed, not to the user.
  if (changes.phone) values.phoneVerifiedAt = null
  if (changes.email) values.emailVerifiedAt = null
  const [updated] = await tx.update(users).set(values).where(eq(users.id, user.id)).returning()
  // A code that is out to confirm the old number is bound to it and confirms nothing any more. It is ended, so
  // that the pages offer to send one to the new number instead of asking for it. After the user's row is held,
  // which is the order `confirmPhone` takes the two in.
  if (changes.phone) await withdrawCodeUnlessHeld(tx, { userId: user.id, purpose: 'activation' })
  await recordAuditEvent(
    tx,
    audit(context, {
      action: 'user.update',
      target: { type: 'user', id: user.id },
      details: { email: updated!.email, changes },
    }),
  )
  return { user: updated!, changed: true as const, changes }
}

/**
 * Deletes a user and everything that hangs on them, including sessions and tokens. The audit event keeps who they were.
 * Returns the logouts to send to the applications they were signed in to.
 */
export const deleteUser = async (tx: DatabaseOrTransaction, context: RequestContext, user: UserRow) => {
  await assertAdminStays(tx, context, user, 'delete')
  const { sessionsEnded, clientsToNotify, logouts } = await endUserSessions(tx, user.id)
  await recordAuditEvent(
    tx,
    audit(context, {
      action: 'user.delete',
      target: { type: 'user', id: user.id },
      details: { email: user.email, firstName: user.firstName, lastName: user.lastName, sessionsEnded, clientsToNotify },
    }),
  )
  await tx.delete(users).where(eq(users.id, user.id))
  return { logouts }
}
