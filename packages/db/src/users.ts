import { eq } from 'drizzle-orm'
import type { DatabaseOrTransaction, Transaction } from './audit.js'
import type { Database } from './index.js'
import { users } from './schema/index.js'

/** Looks a user up by login name, whatever their status. E-mails are stored lowercase. */
export const findUserByEmail = async (db: Database, email: string) => {
  const [user] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase()))
  return user
}

export const recordLogin = async (db: Database, userId: string) => {
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId))
}

/**
 * Takes the person's row for the rest of the transaction. Ending a person's sessions takes it first, and so does
 * whatever keeps something for them on the strength of having just shown who they are: accepting a code that
 * leads to an offer, storing a passkey. So each of these happens wholly before or wholly after the sessions were
 * ended, never across it.
 */
export const lockUserRow = async (tx: DatabaseOrTransaction, userId: string) => {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update')
}

/** Runs `work` in a transaction that holds the person's row from the start; see `lockUserRow`. */
export const whileUserHeld = <Result>(db: Database, userId: string, work: (tx: Transaction) => Promise<Result>) =>
  db.transaction(async (tx) => {
    await lockUserRow(tx, userId)
    return work(tx)
  })
