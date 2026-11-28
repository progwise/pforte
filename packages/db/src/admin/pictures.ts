import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { type DatabaseOrTransaction, recordAuditEvent } from '../audit.js'
import type { Database } from '../index.js'
import { userPictures, users } from '../schema/index.js'
import type { RequestContext } from './users.js'

type UserRow = typeof users.$inferSelect

const audit = (context: RequestContext, action: string, user: UserRow, details: Record<string, unknown>) => ({
  actor: context.actor,
  ip: context.ip,
  userAgent: context.userAgent,
  action,
  target: { type: 'user', id: user.id },
  details: { email: user.email, ...details, ...(context.self ? { self: true } : {}) },
})

/**
 * Gives a person this picture, in place of the one they had. `image` is what pforte serves, byte for byte: the
 * caller has made it from what was uploaded. Returns the person, or undefined when there is no such user.
 *
 * The picture gets a new key, and with it a new address: an application that keeps pictures by their address
 * notices the change, and the address of the old picture answers nothing any more. The key is random and says
 * nothing about the person, because the address is fetched without a sign-in.
 *
 * The person's row is held, so that two pictures arriving at once are stored one after the other and the row
 * names the one that is there.
 */
export const setPicture = (db: Database, context: RequestContext, { userId, image }: { userId: string; image: Buffer }) =>
  db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('no key update')
    if (!user) return undefined
    const key = randomBytes(16).toString('base64url')
    await tx.delete(userPictures).where(eq(userPictures.userId, userId))
    await tx.insert(userPictures).values({ key, userId, image })
    const [changed] = await tx.update(users).set({ pictureKey: key }).where(eq(users.id, userId)).returning()
    await recordAuditEvent(tx, audit(context, 'user.picture.set', changed!, { bytes: image.length, replaced: user.pictureKey !== null }))
    return changed!
  })

/**
 * Removes a person's picture: its address answers nothing any more, and applications get no `picture` from the
 * next sign-in on. Returns the person, or undefined when there is no such user or they have no picture.
 */
export const removePicture = (db: Database, context: RequestContext, userId: string) =>
  db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('no key update')
    if (!user?.pictureKey) return undefined
    await tx.delete(userPictures).where(eq(userPictures.userId, userId))
    const [changed] = await tx.update(users).set({ pictureKey: null }).where(eq(users.id, userId)).returning()
    await recordAuditEvent(tx, audit(context, 'user.picture.remove', changed!, {}))
    return changed!
  })

/**
 * The picture at this key, for serving it. Only the one its person has now, and only while they are active: the
 * picture of somebody who was locked or deactivated is not shown to anybody until they are back.
 */
export const findPicture = async (db: DatabaseOrTransaction, key: string) => {
  const [picture] = await db
    .select({ image: userPictures.image })
    .from(userPictures)
    .innerJoin(users, and(eq(users.id, userPictures.userId), eq(users.pictureKey, userPictures.key)))
    .where(and(eq(userPictures.key, key), eq(users.status, 'active')))
  return picture
}
