import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase, hasDatabase } from '../test/test-database.js'
import type { Transaction } from '../audit.js'
import { endSessions, lockUser, requestPasswordReset } from './lifecycle.js'
import {
  addPasskey,
  closePasskeyOffer,
  continuePasskeyOffer,
  deleteExpiredPasskeyChallenges,
  deleteExpiredPasskeyOffers,
  findPasskeyByCredentialId,
  findPasskeyOffer,
  listPasskeys,
  MAX_PASSKEYS,
  openPasskeyChallenge,
  openPasskeyOffer,
  recordPasskeyUse,
  removePasskey,
  takePasskeyChallenge,
} from './passkeys.js'
import { whileUserHeld } from '../users.js'
import { createUser, deleteUser, findUserById } from './users.js'

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

  describe('work that holds the person\'s row', () => {
    it('waits for sessions that are being ended, and is seen whole by sessions that are ended after it', async () => {
      await database.pool.query(`update users set status = 'active', password_hash = 'x' where id = $1`, [anna.id])
      const order: string[] = []
      let holding!: () => void
      const held = new Promise<void>((resolve) => (holding = resolve))
      let go!: () => void
      const released = new Promise<void>((resolve) => (go = resolve))
      const ending = database.db.transaction(async (tx) => {
        await endSessions(tx, context, (await findUserById(tx, anna.id))!)
        holding()
        await released
        order.push('sessions ended')
      })
      await held

      // Something is kept for the person on the strength of a code: here, an offer.
      const keeping = whileUserHeld(database.db, anna.id, async (tx) => {
        order.push('code accepted')
        return openPasskeyOffer(tx, { userId: anna.id, boundTo: 'offer:interaction-1', details: {} }, new Date(Date.now() + 60_000))
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      // It has not begun: the code is not accepted while the sessions are being ended.
      expect(order).toEqual([])
      go()
      const token = await keeping
      await ending
      expect(order).toEqual(['sessions ended', 'code accepted'])

      // And once it is done, it is all there for the next ending of sessions to find.
      await database.db.transaction(async (tx) => endSessions(tx, context, (await findUserById(tx, anna.id))!))
      expect(await findPasskeyOffer(database.db, { token, boundTo: 'offer:interaction-1' })).toBeUndefined()
    })
  })

  describe('what entitles the person is asked again where the passkey is stored', () => {
    it('stores nothing when the answer is no, and keeps what the question changed', async () => {
      const token = await openPasskeyOffer(database.db, { userId: anna.id, boundTo: 'activation', details: {} }, new Date(Date.now() + 60_000))
      const closeIt = async (tx: Transaction) => Boolean(await closePasskeyOffer(tx, { token, boundTo: 'activation' }))

      expect((await database.db.transaction((tx) => addPasskey(tx, context, anna, passkey('first'), closeIt))).kind).toBe('added')
      // The offer went with the first passkey. A second answer finds it closed.
      expect(await database.db.transaction((tx) => addPasskey(tx, context, anna, passkey('second'), closeIt))).toEqual({ kind: 'revoked' })

      expect((await listPasskeys(database.db, anna.id)).map((row) => row.label)).toEqual(['first'])
      expect(await events('user.passkey.add')).toHaveLength(1)
    })

    it('keeps the offer open when the passkey cannot be stored after all', async () => {
      const token = await openPasskeyOffer(database.db, { userId: anna.id, boundTo: 'activation', details: {} }, new Date(Date.now() + 60_000))

      await expect(
        database.db.transaction(async (tx) => {
          await addPasskey(tx, context, anna, passkey('lost'), async (inner) => Boolean(await closePasskeyOffer(inner, { token, boundTo: 'activation' })))
          throw new Error('something went wrong afterwards')
        }),
      ).rejects.toThrow('something went wrong afterwards')

      expect(await listPasskeys(database.db, anna.id)).toEqual([])
      expect(await findPasskeyOffer(database.db, { token, boundTo: 'activation' })).toBeDefined()
    })

    it('happens after sessions that are being ended, never in the middle: both take the person\'s row first', async () => {
      const token = await openPasskeyOffer(database.db, { userId: anna.id, boundTo: 'activation', details: {} }, new Date(Date.now() + 60_000))
      await database.pool.query(`update users set status = 'active', password_hash = 'x' where id = $1`, [anna.id])
      const order: string[] = []
      let holding!: () => void
      const held = new Promise<void>((resolve) => (holding = resolve))
      let go!: () => void
      const released = new Promise<void>((resolve) => (go = resolve))

      // The sessions are being ended: the row is taken, the offer deleted, the transaction not finished yet.
      const ending = database.db.transaction(async (tx) => {
        await endSessions(tx, context, (await findUserById(tx, anna.id))!)
        holding()
        await released
        order.push('sessions ended')
      })
      await held
      const adding = database.db
        .transaction((tx) => addPasskey(tx, context, anna, passkey('too-late'), async (inner) => Boolean(await closePasskeyOffer(inner, { token, boundTo: 'activation' }))))
        .then((result) => {
          order.push(`passkey: ${result.kind}`)
        })
      await new Promise((resolve) => setTimeout(resolve, 100))
      // The passkey waits. It has not been stored on the strength of an offer that is about to be gone.
      expect(order).toEqual([])
      go()
      await Promise.all([ending, adding])

      expect(order).toEqual(['sessions ended', 'passkey: revoked'])
      expect(await listPasskeys(database.db, anna.id)).toEqual([])
    })
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
    expect(await recordPasskeyUse(database.db, found!, { counter: 5, synced: false }, when)).toBe(true)
    expect(await listPasskeys(database.db, anna.id)).toMatchObject([{ lastUsedAt: when, synced: false }])
    expect((await findPasskeyByCredentialId(database.db, 'credential-one'))!.counter).toBe(5)
  })

  describe('noting that a passkey was used', () => {
    const stored = async (name: string) => {
      await add(context, anna, passkey(name))
      return (await findPasskeyByCredentialId(database.db, `credential-${name}`))!
    }

    it('is refused when another sign-in was checked against the same counter and got there first: the counter never goes back', async () => {
      const checked = await stored('counting')

      // Two sign-ins, both checked against counter 0. The device said 6 to one and 5 to the other.
      expect(await recordPasskeyUse(database.db, checked, { counter: 6, synced: true })).toBe(true)
      expect(await recordPasskeyUse(database.db, checked, { counter: 5, synced: true })).toBe(false)

      expect((await findPasskeyByCredentialId(database.db, 'credential-counting'))!.counter).toBe(6)
    })

    it('lets one of several through when they come at the same moment', async () => {
      const checked = await stored('at-once')
      await Promise.all(Array.from({ length: 6 }, () => database.pool.query('select pg_sleep(0.05)')))

      const noted = await Promise.all([3, 4, 5, 6, 7, 8].map((counter) => recordPasskeyUse(database.db, checked, { counter, synced: true })))

      expect(noted.filter(Boolean)).toHaveLength(1)
    })

    it('is refused for a passkey that was removed after it was checked', async () => {
      const checked = await stored('removed')
      await database.pool.query(`delete from passkeys where id = $1`, [checked.id])

      expect(await recordPasskeyUse(database.db, checked, { counter: 0, synced: true })).toBe(false)
    })

    it('does not hold up a passkey that does not count: its counter stays 0, sign-in after sign-in and side by side', async () => {
      const checked = await stored('synced')

      expect(await Promise.all([1, 2, 3].map(() => recordPasskeyUse(database.db, checked, { counter: 0, synced: true })))).toEqual([true, true, true])
      expect(await recordPasskeyUse(database.db, checked, { counter: 0, synced: true })).toBe(true)
    })
  })

  describe('the offer of a passkey', () => {
    const soon = () => new Date(Date.now() + 15 * 60_000)
    const open = (user = anna, boundTo = 'offer:interaction-1', expiresAt = soon()) => openPasskeyOffer(database.db, { userId: user.id, boundTo, details: { acr: 'x', amr: ['pwd', 'otp'] } }, expiresAt)
    const offers = async () => Number((await database.pool.query('select count(*) from passkey_offers')).rows[0].count)

    beforeEach(async () => {
      await database.pool.query('delete from passkey_offers')
    })

    it('is found by the token of the browser, in its own place, with what was noted about it', async () => {
      const token = await open()

      expect(await findPasskeyOffer(database.db, { token, boundTo: 'offer:interaction-1' })).toEqual({ userId: anna.id, details: { acr: 'x', amr: ['pwd', 'otp'] } })
      expect(await findPasskeyOffer(database.db, { token, boundTo: 'offer:interaction-2' })).toBeUndefined()
      expect(await findPasskeyOffer(database.db, { token, boundTo: 'activation' })).toBeUndefined()
      expect(await findPasskeyOffer(database.db, { token: 'another token', boundTo: 'offer:interaction-1' })).toBeUndefined()
      expect(await findPasskeyOffer(database.db, { token: '', boundTo: 'offer:interaction-1' })).toBeUndefined()
    })

    it('keeps the token itself out of the database', async () => {
      const token = await open()
      const { rows } = await database.pool.query('select * from passkey_offers')
      expect(JSON.stringify(rows)).not.toContain(token)
    })

    it('is closed once: after that its token stands for nothing, also at the same moment', async () => {
      const token = await open()
      const offer = { token, boundTo: 'offer:interaction-1' }

      const closed = await Promise.all(Array.from({ length: 6 }, () => closePasskeyOffer(database.db, offer)))

      expect(closed.filter(Boolean)).toEqual([{ userId: anna.id, details: { acr: 'x', amr: ['pwd', 'otp'] } }])
      expect(await findPasskeyOffer(database.db, offer)).toBeUndefined()
      expect(await closePasskeyOffer(database.db, offer)).toBeUndefined()
    })

    it('is carried on to its next step while it is open, and not opened again once it is over', async () => {
      const token = await openPasskeyOffer(database.db, { userId: anna.id, boundTo: 'activation', details: { clientId: 'demo-web', done: 'account' } }, soon())
      const offer = { token, boundTo: 'activation' }
      const later = new Date(Date.now() + 60 * 60_000)

      expect(await continuePasskeyOffer(database.db, offer, { details: { done: 'phone' }, expiresAt: later })).toBe(true)
      expect(await findPasskeyOffer(database.db, offer)).toEqual({ userId: anna.id, details: { clientId: 'demo-web', done: 'phone' } })
      expect((await database.pool.query('select expires_at from passkey_offers')).rows[0].expires_at).toEqual(later)

      // Not in another place, not with another token, and not after it was closed or has run out.
      expect(await continuePasskeyOffer(database.db, { token, boundTo: 'offer:interaction-1' }, { details: {}, expiresAt: later })).toBe(false)
      expect(await continuePasskeyOffer(database.db, { token: 'another', boundTo: 'activation' }, { details: {}, expiresAt: later })).toBe(false)
      await closePasskeyOffer(database.db, offer)
      expect(await continuePasskeyOffer(database.db, offer, { details: {}, expiresAt: later })).toBe(false)
      const old = await open(anna, 'activation', new Date(Date.now() - 1000))
      expect(await continuePasskeyOffer(database.db, { token: old, boundTo: 'activation' }, { details: {}, expiresAt: later })).toBe(false)
      expect(await offers()).toBe(1)
    })

    it('runs out', async () => {
      const token = await open(anna, 'activation', new Date(Date.now() - 1000))

      expect(await findPasskeyOffer(database.db, { token, boundTo: 'activation' })).toBeUndefined()
      expect(await closePasskeyOffer(database.db, { token, boundTo: 'activation' })).toBeUndefined()
      await open(ben, 'activation', new Date(Date.now() - 1000))
      await open(ben)
      expect(await deleteExpiredPasskeyOffers(database.db)).toBe(1)
      expect(await offers()).toBe(1)
    })

    it.each([
      ['their sessions are ended', (tx: Transaction) => endSessions(tx, context, anna)],
      ['they are locked', (tx: Transaction) => lockUser(tx, context, anna)],
      ['an administrator starts a password reset for them', (tx: Transaction) => requestPasswordReset(tx, context, anna)],
    ])('ends, with every open question about a passkey, when %s; somebody else is not touched', async (_name, change) => {
      await database.pool.query(`update users set status = 'active', locked_at = null, password_hash = 'x' where id = $1`, [anna.id])
      anna = (await database.db.transaction((tx) => findUserById(tx, anna.id)))!
      const annas = await open()
      const bens = await open(ben, 'activation')
      await openPasskeyChallenge(database.db, { challenge: 'annas-question', userId: anna.id, boundTo: 'offer:interaction-1' }, soon())
      await openPasskeyChallenge(database.db, { challenge: 'bens-question', userId: ben.id, boundTo: 'activation:ben' }, soon())
      await openPasskeyChallenge(database.db, { challenge: 'a-login-page', boundTo: 'sign-in:interaction-9' }, soon())

      await database.db.transaction(change)

      expect(await findPasskeyOffer(database.db, { token: annas, boundTo: 'offer:interaction-1' })).toBeUndefined()
      expect(await takePasskeyChallenge(database.db, { challenge: 'annas-question', userId: anna.id, boundTo: 'offer:interaction-1' })).toBe(false)
      expect(await findPasskeyOffer(database.db, { token: bens, boundTo: 'activation' })).toBeDefined()
      expect(await takePasskeyChallenge(database.db, { challenge: 'bens-question', userId: ben.id, boundTo: 'activation:ben' })).toBe(true)
      expect(await takePasskeyChallenge(database.db, { challenge: 'a-login-page', boundTo: 'sign-in:interaction-9' })).toBe(true)
    })
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
