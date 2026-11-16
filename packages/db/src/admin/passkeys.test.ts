import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase, hasDatabase } from '../test/test-database.js'
import { addPasskey, deleteExpiredPasskeyChallenges, findPasskeyByCredentialId, listPasskeys, MAX_PASSKEYS, openPasskeyChallenge, recordPasskeyUse, removePasskey, takePasskeyChallenge } from './passkeys.js'
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
    await database.pool.query('delete from passkey_challenges')
    await database.pool.query(`delete from audit_events where action like 'user.passkey.%'`)
  })

  /** In a transaction of its own, as every caller does it: the person's row is locked until it ends. */
  const add = (who: Parameters<typeof addPasskey>[1], user: Parameters<typeof addPasskey>[2], passkey: Parameters<typeof addPasskey>[3]) =>
    database.db.transaction((tx) => addPasskey(tx, who, user, passkey))
  const events = async (action: string) => (await database.pool.query(`select * from audit_events where action = $1 order by created_at`, [action])).rows

  it('stores a passkey with its audit event and lists it for its person only', async () => {
    const added = await add(context, anna, passkey('one'))

    expect(added).toMatchObject({ kind: 'added', label: 'one' })
    expect(await listPasskeys(database.db, anna.id)).toMatchObject([{ credentialId: 'credential-one', transports: ['internal'], synced: true, label: 'one', lastUsedAt: null }])
    expect(await listPasskeys(database.db, ben.id)).toEqual([])
    const [event] = await events('user.passkey.add')
    expect(event).toMatchObject({ actor_type: 'client', actor_id: 'tester', target_id: anna.id })
    expect(event.details).toEqual({ email: 'anna@example.com', passkeyId: added.kind === 'added' ? added.id : '', label: 'one', synced: true })
  })

  it('marks what a person does to their own account', async () => {
    await add({ ...context, actor: { type: 'user', id: anna.id }, self: true }, anna, passkey('own'))
    expect((await events('user.passkey.add'))[0].details).toMatchObject({ self: true })
  })

  it('knows a credential once, whoever has it', async () => {
    await add(context, anna, passkey('one'))

    expect(await add(context, anna, passkey('one'))).toEqual({ kind: 'duplicate' })
    expect(await add(context, ben, passkey('one'))).toEqual({ kind: 'duplicate' })
    expect(await listPasskeys(database.db, ben.id)).toEqual([])
    expect(await events('user.passkey.add')).toHaveLength(1)
  })

  it('stops at the most a person may have', async () => {
    for (let n = 0; n < MAX_PASSKEYS; n++) expect((await add(context, anna, passkey(`n${n}`))).kind).toBe('added')

    expect(await add(context, anna, passkey('one-too-many'))).toEqual({ kind: 'too-many' })
    expect((await add(context, ben, passkey('bens'))).kind).toBe('added')
    expect(await listPasskeys(database.db, anna.id)).toHaveLength(MAX_PASSKEYS)
  })

  it('holds the limit when several passkeys arrive at the same moment', async () => {
    for (let n = 0; n < MAX_PASSKEYS - 1; n++) await add(context, anna, passkey(`n${n}`))
    // Six connections that are open already. Otherwise the first transaction is through before the second has
    // connected, and nothing happens at the same moment.
    await Promise.all(Array.from({ length: 6 }, () => database.pool.query('select pg_sleep(0.05)')))

    // Each in its own transaction and on its own connection, all started before any has finished.
    const results = await Promise.all(Array.from({ length: 6 }, (_, n) => add(context, anna, passkey(`at-once-${n}`))))

    expect(results.filter((result) => result.kind === 'added')).toHaveLength(1)
    expect(results.filter((result) => result.kind === 'too-many')).toHaveLength(5)
    expect(await listPasskeys(database.db, anna.id)).toHaveLength(MAX_PASSKEYS)
    // Somebody else is not held up by it, nor counted with it.
    expect((await add(context, ben, passkey('bens'))).kind).toBe('added')
  })

  it('removes a passkey of the person and no other', async () => {
    const own = await add(context, anna, passkey('own'))
    const other = await add(context, ben, passkey('other'))
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

  it('is found by the id its device knows it by, and notes when it was used', async () => {
    const added = await add(context, anna, passkey('one'))
    if (added.kind !== 'added') throw new Error('not added')

    const found = await findPasskeyByCredentialId(database.db, 'credential-one')
    expect(found).toEqual({ id: added.id, userId: anna.id, credentialId: 'credential-one', publicKey: 'key-one', counter: 0, transports: ['internal'] })
    expect(await findPasskeyByCredentialId(database.db, 'credential-nobody-has')).toBeUndefined()

    const when = new Date('2026-11-16T10:00:00Z')
    await recordPasskeyUse(database.db, added.id, { counter: 5, synced: false }, when)
    expect(await listPasskeys(database.db, anna.id)).toMatchObject([{ lastUsedAt: when, synced: false }])
    expect((await findPasskeyByCredentialId(database.db, 'credential-one'))!.counter).toBe(5)
  })

  it('keeps a long label short', async () => {
    await add(context, anna, { ...passkey('long'), label: 'x'.repeat(500) })
    expect((await listPasskeys(database.db, anna.id))[0]!.label).toHaveLength(100)
  })

  describe('the question a device is asked', () => {
    const soon = () => new Date(Date.now() + 5 * 60_000)
    const asked = (challenge: string, user = anna, boundTo = 'account:grant-1') => ({ challenge, userId: user.id, boundTo })
    const pending = async () => Number((await database.pool.query('select count(*) from passkey_challenges')).rows[0].count)

    it('is good for one answer', async () => {
      await openPasskeyChallenge(database.db, asked('q1'), soon())

      expect(await takePasskeyChallenge(database.db, asked('q1'))).toBe(true)
      expect(await takePasskeyChallenge(database.db, asked('q1'))).toBe(false)
      expect(await pending()).toBe(0)
    })

    it('is good for one answer when two come at the same moment', async () => {
      await openPasskeyChallenge(database.db, asked('q1'), soon())

      const taken = await Promise.all(Array.from({ length: 8 }, () => takePasskeyChallenge(database.db, asked('q1'))))

      expect(taken.filter(Boolean)).toHaveLength(1)
    })

    it('is not there for somebody else or for another sign-in of the same person, and stays for its own', async () => {
      await openPasskeyChallenge(database.db, asked('q1'), soon())

      expect(await takePasskeyChallenge(database.db, asked('q1', ben))).toBe(false)
      expect(await takePasskeyChallenge(database.db, asked('q1', anna, 'account:grant-2'))).toBe(false)
      expect(await takePasskeyChallenge(database.db, asked('never-asked'))).toBe(false)
      expect(await takePasskeyChallenge(database.db, asked('q1'))).toBe(true)
    })

    it('runs out, and is used up by the answer that comes too late', async () => {
      await openPasskeyChallenge(database.db, asked('q1'), new Date(Date.now() - 1000))

      expect(await takePasskeyChallenge(database.db, asked('q1'))).toBe(false)
      expect(await pending()).toBe(0)
    })

    it('clears away what has run out: in a place with its next question, everywhere with the cleanup', async () => {
      const past = new Date(Date.now() - 1000)
      await openPasskeyChallenge(database.db, asked('annas-old'), past, { now: new Date(0) })
      await openPasskeyChallenge(database.db, asked('bens-open', ben, 'account:grant-7'), soon())
      await openPasskeyChallenge(database.db, asked('bens-old', ben, 'account:grant-9'), past, { now: new Date(0) })

      await openPasskeyChallenge(database.db, asked('annas-new'), soon())
      expect(await pending()).toBe(3)

      expect(await deleteExpiredPasskeyChallenges(database.db)).toBe(1)
      expect(await takePasskeyChallenge(database.db, asked('annas-new'))).toBe(true)
      expect(await takePasskeyChallenge(database.db, asked('bens-open', ben, 'account:grant-7'))).toBe(true)
    })

    it('of a sign-in names nobody, and is not the question of a new passkey in the same place', async () => {
      const signIn = { challenge: 'q-sign-in', boundTo: 'sign-in:interaction-1' }
      await openPasskeyChallenge(database.db, signIn, soon())

      // Not for a person, not in another sign-in.
      expect(await takePasskeyChallenge(database.db, { ...signIn, userId: anna.id })).toBe(false)
      expect(await takePasskeyChallenge(database.db, { ...signIn, boundTo: 'sign-in:interaction-2' })).toBe(false)
      expect(await takePasskeyChallenge(database.db, signIn)).toBe(true)

      // And the other way round: a question about a new passkey is none for a sign-in.
      await openPasskeyChallenge(database.db, asked('q-create', anna, 'offer:interaction-1'), soon())
      expect(await takePasskeyChallenge(database.db, { challenge: 'q-create', boundTo: 'offer:interaction-1' })).toBe(false)
    })

    it('can be the only one of its place: a login page that is shown again has the newest question', async () => {
      const place = 'sign-in:interaction-1'
      await openPasskeyChallenge(database.db, { challenge: 'first', boundTo: place }, soon(), { only: true })
      await openPasskeyChallenge(database.db, { challenge: 'elsewhere', boundTo: 'sign-in:interaction-2' }, soon(), { only: true })
      await openPasskeyChallenge(database.db, { challenge: 'second', boundTo: place }, soon(), { only: true })

      expect(await takePasskeyChallenge(database.db, { challenge: 'first', boundTo: place })).toBe(false)
      expect(await takePasskeyChallenge(database.db, { challenge: 'second', boundTo: place })).toBe(true)
      expect(await takePasskeyChallenge(database.db, { challenge: 'elsewhere', boundTo: 'sign-in:interaction-2' })).toBe(true)
    })

    it('goes with the person when they are deleted', async () => {
      const dora = await database.db.transaction((tx) => createUser(tx, context, { email: 'dora@example.com', firstName: 'Dora', lastName: 'D' }))
      await openPasskeyChallenge(database.db, asked('doras', dora), soon())

      await database.db.transaction((tx) => deleteUser(tx, context, dora))

      expect(await pending()).toBe(0)
    })
  })

  it('goes with the person when they are deleted', async () => {
    const carl = await database.db.transaction((tx) => createUser(tx, context, { email: 'carl@example.com', firstName: 'Carl', lastName: 'C' }))
    await add(context, carl, passkey('carls'))

    await database.db.transaction((tx) => deleteUser(tx, context, carl))

    expect(Number((await database.pool.query(`select count(*) from passkeys where credential_id = 'credential-carls'`)).rows[0].count)).toBe(0)
  })
})
