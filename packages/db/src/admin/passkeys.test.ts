import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase, hasDatabase } from '../test/test-database.js'
import { addPasskey, listPasskeys, MAX_PASSKEYS, removePasskey } from './passkeys.js'
import { createUser, deleteUser } from './users.js'

const context = { actor: { type: 'client' as const, id: 'tester' }, ip: '203.0.113.7', userAgent: 'vitest' }
const passkey = (name: string) => ({ credentialId: `credential-${name}`, publicKey: `key-${name}`, counter: 0, transports: ['internal'], synced: true, label: name })

describe.skipIf(!hasDatabase)('passkeys', () => {
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
    await database.pool.query('delete from passkeys')
    await database.pool.query(`delete from audit_events where action like 'user.passkey.%'`)
  })

  const events = async (action: string) => (await database.pool.query(`select * from audit_events where action = $1 order by created_at`, [action])).rows

  it('stores a passkey with its audit event and lists it for its person only', async () => {
    const added = await addPasskey(database.db, context, anna, passkey('one'))

    expect(added).toMatchObject({ kind: 'added', label: 'one' })
    expect(await listPasskeys(database.db, anna.id)).toMatchObject([{ credentialId: 'credential-one', transports: ['internal'], synced: true, label: 'one', lastUsedAt: null }])
    expect(await listPasskeys(database.db, ben.id)).toEqual([])
    const [event] = await events('user.passkey.add')
    expect(event).toMatchObject({ actor_type: 'client', actor_id: 'tester', target_id: anna.id })
    expect(event.details).toEqual({ email: 'anna@example.com', passkeyId: added.kind === 'added' ? added.id : '', label: 'one', synced: true })
  })

  it('marks what a person does to their own account', async () => {
    await addPasskey(database.db, { ...context, actor: { type: 'user', id: anna.id }, self: true }, anna, passkey('own'))
    expect((await events('user.passkey.add'))[0].details).toMatchObject({ self: true })
  })

  it('knows a credential once, whoever has it', async () => {
    await addPasskey(database.db, context, anna, passkey('one'))

    expect(await addPasskey(database.db, context, anna, passkey('one'))).toEqual({ kind: 'duplicate' })
    expect(await addPasskey(database.db, context, ben, passkey('one'))).toEqual({ kind: 'duplicate' })
    expect(await listPasskeys(database.db, ben.id)).toEqual([])
    expect(await events('user.passkey.add')).toHaveLength(1)
  })

  it('stops at the most a person may have', async () => {
    for (let n = 0; n < MAX_PASSKEYS; n++) expect((await addPasskey(database.db, context, anna, passkey(`n${n}`))).kind).toBe('added')

    expect(await addPasskey(database.db, context, anna, passkey('one-too-many'))).toEqual({ kind: 'too-many' })
    expect((await addPasskey(database.db, context, ben, passkey('bens'))).kind).toBe('added')
    expect(await listPasskeys(database.db, anna.id)).toHaveLength(MAX_PASSKEYS)
  })

  it('removes a passkey of the person and no other', async () => {
    const own = await addPasskey(database.db, context, anna, passkey('own'))
    const other = await addPasskey(database.db, context, ben, passkey('other'))
    if (own.kind !== 'added' || other.kind !== 'added') throw new Error('not added')

    expect(await removePasskey(database.db, context, anna, other.id)).toBe(false)
    expect(await removePasskey(database.db, context, anna, own.id)).toBe(true)
    expect(await removePasskey(database.db, context, anna, own.id)).toBe(false)

    expect(await listPasskeys(database.db, anna.id)).toEqual([])
    expect(await listPasskeys(database.db, ben.id)).toHaveLength(1)
    const removed = await events('user.passkey.remove')
    expect(removed).toHaveLength(1)
    expect(removed[0].details).toEqual({ email: 'anna@example.com', passkeyId: own.id, label: 'own' })
  })

  it('keeps a long label short', async () => {
    await addPasskey(database.db, context, anna, { ...passkey('long'), label: 'x'.repeat(500) })
    expect((await listPasskeys(database.db, anna.id))[0]!.label).toHaveLength(100)
  })

  it('goes with the person when they are deleted', async () => {
    const carl = await database.db.transaction((tx) => createUser(tx, context, { email: 'carl@example.com', firstName: 'Carl', lastName: 'C' }))
    await addPasskey(database.db, context, carl, passkey('carls'))

    await database.db.transaction((tx) => deleteUser(tx, context, carl))

    expect(Number((await database.pool.query(`select count(*) from passkeys where credential_id = 'credential-carls'`)).rows[0].count)).toBe(0)
  })
})
