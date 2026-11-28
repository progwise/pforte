import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase, hasDatabase } from '../test/test-database.js'
import { findPicture, removePicture, setPicture } from './pictures.js'
import { createUser, deleteUser, findUserById } from './users.js'

const context = { actor: { type: 'client' as const, id: 'tester' }, ip: '203.0.113.7', userAgent: 'vitest' }
const self = (userId: string) => ({ actor: { type: 'user' as const, id: userId }, ip: '203.0.113.7', userAgent: 'vitest', self: true })
const image = (name: string) => Buffer.from(`picture of ${name}`)

describe.skipIf(!hasDatabase)('the picture of a person', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>
  let anna: Awaited<ReturnType<typeof createUser>>
  let ben: Awaited<ReturnType<typeof createUser>>

  beforeAll(async () => {
    database = await createTestDatabase()
    anna = await database.db.transaction((tx) => createUser(tx, context, { email: 'anna@example.com', firstName: 'Anna', lastName: 'A' }))
    ben = await database.db.transaction((tx) => createUser(tx, context, { email: 'ben@example.com', firstName: 'Ben', lastName: 'B' }))
  })

  afterAll(async () => {
    await database?.drop()
  })

  beforeEach(async () => {
    await database.pool.query('delete from user_pictures')
    await database.pool.query(`update users set picture_key = null, status = 'active'`)
    await database.pool.query(`delete from audit_events where action like 'user.picture.%'`)
  })

  const events = async (action: string) => (await database.pool.query(`select * from audit_events where action = $1 order by created_at`, [action])).rows
  const stored = async () => (await database.pool.query(`select user_id, key from user_pictures order by created_at`)).rows

  it('stores the picture under a random key, names it in the person’s row and records who did it', async () => {
    const changed = await setPicture(database.db, self(anna.id), { userId: anna.id, image: image('anna') })

    expect(changed?.pictureKey).toMatch(/^[\w-]{22}$/)
    expect((await findUserById(database.db, anna.id))!.pictureKey).toBe(changed!.pictureKey)
    expect((await findPicture(database.db, changed!.pictureKey!))?.image.equals(image('anna'))).toBe(true)
    expect((await findUserById(database.db, ben.id))!.pictureKey).toBeNull()
    const [event] = await events('user.picture.set')
    expect(event).toMatchObject({ actor_type: 'user', actor_id: anna.id, target_id: anna.id, details: { email: 'anna@example.com', self: true, replaced: false, bytes: image('anna').length } })
    // The log says that there is a picture, and holds nothing of it: neither the bytes nor where it is served.
    expect(JSON.stringify(event.details)).not.toContain(changed!.pictureKey!)
  })

  it('gives a new picture a new key, and the old one answers nothing any more', async () => {
    const first = (await setPicture(database.db, self(anna.id), { userId: anna.id, image: image('one') }))!.pictureKey!
    const second = (await setPicture(database.db, self(anna.id), { userId: anna.id, image: image('two') }))!.pictureKey!

    expect(second).not.toBe(first)
    expect(await findPicture(database.db, first)).toBeUndefined()
    expect((await findPicture(database.db, second))?.image.equals(image('two'))).toBe(true)
    expect(await stored()).toEqual([{ user_id: anna.id, key: second }])
    expect((await events('user.picture.set')).map((event) => event.details.replaced)).toEqual([false, true])
  })

  it('keeps one picture when two arrive at the same moment, and the row names the one that is there', async () => {
    await Promise.all([1, 2, 3, 4].map((n) => setPicture(database.db, self(anna.id), { userId: anna.id, image: image(`at once ${n}`) })))

    const rows = await stored()
    expect(rows).toHaveLength(1)
    expect((await findUserById(database.db, anna.id))!.pictureKey).toBe(rows[0].key)
  })

  it('removes the picture, for the person and for an administrator, and says so when there was none', async () => {
    const key = (await setPicture(database.db, self(anna.id), { userId: anna.id, image: image('anna') }))!.pictureKey!

    expect(await removePicture(database.db, context, anna.id)).toMatchObject({ id: anna.id, pictureKey: null })

    expect(await findPicture(database.db, key)).toBeUndefined()
    expect(await stored()).toEqual([])
    expect(await events('user.picture.remove')).toMatchObject([{ actor_type: 'client', actor_id: 'tester', target_id: anna.id }])
    expect((await events('user.picture.remove'))[0].details.self).toBeUndefined()
    // Nothing to remove, and nobody to remove it from.
    expect(await removePicture(database.db, context, anna.id)).toBeUndefined()
    expect(await removePicture(database.db, context, '0190f6a8-0000-7000-8000-000000000000')).toBeUndefined()
    expect(await events('user.picture.remove')).toHaveLength(1)
  })

  it('knows nobody under an unknown ID, and no picture under an unknown key', async () => {
    expect(await setPicture(database.db, context, { userId: '0190f6a8-0000-7000-8000-000000000000', image: image('nobody') })).toBeUndefined()
    expect(await findPicture(database.db, 'x'.repeat(22))).toBeUndefined()
    expect(await stored()).toEqual([])
  })

  it.each(['locked', 'deactivated'] as const)('does not serve the picture of somebody who is %s, and serves it again when they are back', async (status) => {
    const key = (await setPicture(database.db, self(anna.id), { userId: anna.id, image: image('anna') }))!.pictureKey!
    await database.pool.query(`update users set status = $2 where id = $1`, [anna.id, status])

    expect(await findPicture(database.db, key)).toBeUndefined()

    await database.pool.query(`update users set status = 'active' where id = $1`, [anna.id])
    expect(await findPicture(database.db, key)).toBeDefined()
  })

  it('is deleted with its person', async () => {
    const carl = await database.db.transaction((tx) => createUser(tx, context, { email: 'carl@example.com', firstName: 'Carl', lastName: 'C' }))
    const key = (await setPicture(database.db, self(carl.id), { userId: carl.id, image: image('carl') }))!.pictureKey!

    await database.db.transaction(async (tx) => deleteUser(tx, context, (await findUserById(tx, carl.id))!))

    expect(await findPicture(database.db, key)).toBeUndefined()
    expect(await stored()).toEqual([])
  })
})
