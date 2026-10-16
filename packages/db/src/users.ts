import { eq } from 'drizzle-orm'
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
