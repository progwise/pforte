import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, hasDatabase } from '../test/test-database.js'
import {
  addUserClaim,
  ClaimsError,
  createClaimType,
  deleteClaimType,
  getClaimType,
  getUserClaims,
  removeUserClaim,
  setClientClaimTypes,
  setUserClaims,
  updateClaimType,
} from './claims.js'
import { createUser } from './users.js'

const context = { actor: { type: 'client' as const, id: 'tester' }, ip: '203.0.113.7', userAgent: 'vitest' }

describe.skipIf(!hasDatabase)('admin claims', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>
  let counter = 0

  beforeAll(async () => {
    database = await createTestDatabase()
    await database.pool.query(`
      insert into claim_types (key, value_pattern, multi_valued) values
        ('partner_no', '^[0-9]{5}$', true),
        ('customer_no', '^[0-9]{5}$', false),
        ('branch_code', null, false)`)
    await database.pool.query(`
      insert into clients (client_id, name, type, secret_hash) values ('app', 'App', 'confidential', 'hash')`)
  })

  afterAll(async () => {
    await database?.drop()
  })

  const newUser = () =>
    database.db.transaction((tx) =>
      createUser(tx, context, { email: `claims${++counter}@example.com`, firstName: 'C', lastName: `${counter}` }),
    )
  const set = (user: { id: string; email: string }, claims: Record<string, string[]>) =>
    database.db.transaction((tx) => setUserClaims(tx, context, user, claims))
  const events = async (action: string, targetId: string) =>
    (await database.pool.query(`select details from audit_events where action = $1 and target_id = $2`, [action, targetId])).rows
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise
    } catch (error) {
      return error as ClaimsError
    }
    throw new Error('expected a ClaimsError')
  }

  describe('setting claims on a user', () => {
    it('replaces only the claim types given and leaves the others alone', async () => {
      const user = await newUser()
      await set(user, { partner_no: ['00001'], customer_no: ['10001'], branch_code: ['MUC'] })

      const result = await set(user, { partner_no: ['00002', '00003'] })

      expect(result.claims).toEqual({ partner_no: ['00002', '00003'], customer_no: ['10001'], branch_code: ['MUC'] })
    })

    it('removes every value of a type when given an empty list', async () => {
      const user = await newUser()
      await set(user, { partner_no: ['00001', '00002'], branch_code: ['B'] })

      const result = await set(user, { partner_no: [] })

      expect(result.claims).toEqual({ branch_code: ['B'] })
    })

    it('writes only the differences and records an event only when something changed', async () => {
      const user = await newUser()
      await set(user, { partner_no: ['00001', '00002'] })
      const before = (await events('user.claims.set', user.id)).length

      const same = await set(user, { partner_no: ['00002', '00001'] })
      expect(same.changed).toBe(false)
      expect(await events('user.claims.set', user.id)).toHaveLength(before)

      const changed = await set(user, { partner_no: ['00002', '00009'] })
      expect(changed.changed).toBe(true)
      const latest = (await events('user.claims.set', user.id)).at(-1)!
      expect(latest.details.changes).toEqual({ partner_no: { from: ['00001', '00002'], to: ['00002', '00009'] } })
    })

    it('trims and de-duplicates values', async () => {
      const user = await newUser()

      const result = await set(user, { partner_no: [' 00001 ', '00001', '00002'] })

      expect(result.claims.partner_no).toEqual(['00001', '00002'])
    })

    it('reports every problem at once and writes nothing', async () => {
      const user = await newUser()
      await set(user, { branch_code: ['KEEP'] })

      const error = await failure(
        set(user, { partner_no: ['abc'], customer_no: ['10001', '10002'], nonsense: ['x'], branch_code: ['CHANGED'] }),
      )

      expect(error).toBeInstanceOf(ClaimsError)
      expect(error.kind).toBe('invalid')
      expect(error.problems.map((problem) => problem.path).sort()).toEqual([
        '/claims/customer_no',
        '/claims/nonsense',
        '/claims/partner_no',
      ])
      // The valid change to branch_code was not applied either.
      expect(await getUserClaims(database.db, user.id)).toEqual({ branch_code: ['KEEP'] })
    })
  })

  describe('adding and removing one value', () => {
    it('adds a value and is idempotent', async () => {
      const user = await newUser()

      await database.db.transaction((tx) => addUserClaim(tx, context, user, 'partner_no', '00001'))
      const again = await database.db.transaction((tx) => addUserClaim(tx, context, user, 'partner_no', '00001'))
      await database.db.transaction((tx) => addUserClaim(tx, context, user, 'partner_no', '00002'))

      expect(again.changed).toBe(false)
      expect(await getUserClaims(database.db, user.id)).toEqual({ partner_no: ['00001', '00002'] })
    })

    it('refuses a second value for a single-valued type but accepts the same one again', async () => {
      const user = await newUser()
      await database.db.transaction((tx) => addUserClaim(tx, context, user, 'customer_no', '10001'))

      const error = await failure(database.db.transaction((tx) => addUserClaim(tx, context, user, 'customer_no', '10002')))
      expect(error.kind).toBe('conflict')

      const same = await database.db.transaction((tx) => addUserClaim(tx, context, user, 'customer_no', '10001'))
      expect(same.changed).toBe(false)
    })

    it('removes one value, and removing a value that is not there changes nothing', async () => {
      const user = await newUser()
      await set(user, { partner_no: ['00001', '00002'] })

      const removed = await database.db.transaction((tx) => removeUserClaim(tx, context, user, 'partner_no', '00001'))
      const missing = await database.db.transaction((tx) => removeUserClaim(tx, context, user, 'partner_no', '99999'))

      expect(removed.claims).toEqual({ partner_no: ['00002'] })
      expect(missing.changed).toBe(false)
    })
  })

  describe('claim types', () => {
    it('refuses names that tokens already use', async () => {
      for (const key of ['email', 'sub', 'name', 'locale', 'phone_number', 'acr']) {
        const error = await failure(database.db.transaction((tx) => createClaimType(tx, context, { key })))
        expect(error.kind, key).toBe('invalid')
      }
    })

    it('refuses to delete a claim type while users hold values, and says how many', async () => {
      await database.db.transaction((tx) => createClaimType(tx, context, { key: 'in_use', multiValued: true }))
      const users = [await newUser(), await newUser()]
      await set(users[0]!, { in_use: ['a', 'b'] })
      await set(users[1]!, { in_use: ['c'] })
      const claimType = (await getClaimType(database.db, 'in_use'))!

      const error = await failure(database.db.transaction((tx) => deleteClaimType(tx, context, claimType, { force: false })))

      expect(error.kind).toBe('conflict')
      expect(error.message).toContain('2 user(s) hold 3 value(s)')
      expect(await getClaimType(database.db, 'in_use')).toBeDefined()
    })

    it('deletes the values with the type when forced, and records how many', async () => {
      const claimType = (await getClaimType(database.db, 'in_use'))!

      await database.db.transaction((tx) => deleteClaimType(tx, context, claimType, { force: true }))

      expect(await getClaimType(database.db, 'in_use')).toBeUndefined()
      expect((await database.pool.query(`select count(*) from user_claims where claim_type_key = 'in_use'`)).rows[0].count).toBe('0')
      const [event] = await events('claim_type.delete', 'in_use')
      expect(event.details).toMatchObject({ forced: true, usersAffected: 2, valuesDeleted: 3 })
    })

    it('deletes an unused claim type without force', async () => {
      await database.db.transaction((tx) => createClaimType(tx, context, { key: 'unused' }))
      const claimType = (await getClaimType(database.db, 'unused'))!

      await database.db.transaction((tx) => deleteClaimType(tx, context, claimType, { force: false }))

      expect(await getClaimType(database.db, 'unused')).toBeUndefined()
    })

    it('refuses a new pattern that existing values would violate', async () => {
      await database.db.transaction((tx) => createClaimType(tx, context, { key: 'code' }))
      await set(await newUser(), { code: ['abc'] })
      const claimType = (await getClaimType(database.db, 'code'))!

      const error = await failure(
        database.db.transaction((tx) => updateClaimType(tx, context, claimType, { valuePattern: '^[0-9]+$' })),
      )

      expect(error.kind).toBe('conflict')
      expect(error.message).toContain('1 existing value')
    })

    it('refuses to become single-valued while a user holds several values', async () => {
      const user = await newUser()
      await set(user, { partner_no: ['00010', '00011'] })
      const claimType = (await getClaimType(database.db, 'partner_no'))!

      const error = await failure(database.db.transaction((tx) => updateClaimType(tx, context, claimType, { multiValued: false })))

      expect(error.kind).toBe('conflict')
    })

    it('updates the description and records nothing when nothing differs', async () => {
      const claimType = (await getClaimType(database.db, 'branch_code'))!

      const changed = await database.db.transaction((tx) => updateClaimType(tx, context, claimType, { description: 'Branch' }))
      const same = await database.db.transaction((tx) => updateClaimType(tx, context, changed.claimType, { description: 'Branch' }))

      expect(changed.changed).toBe(true)
      expect(same.changed).toBe(false)
      expect(await events('claim_type.update', 'branch_code')).toHaveLength(1)
    })
  })

  describe('claim types of a client', () => {
    it('replaces the set, and does nothing when it is the same', async () => {
      const first = await database.db.transaction((tx) => setClientClaimTypes(tx, context, 'app', ['partner_no', 'customer_no']))
      const same = await database.db.transaction((tx) => setClientClaimTypes(tx, context, 'app', ['customer_no', 'partner_no']))
      const fewer = await database.db.transaction((tx) => setClientClaimTypes(tx, context, 'app', ['partner_no']))

      expect(first.claimTypes).toEqual(['customer_no', 'partner_no'])
      expect(same.changed).toBe(false)
      expect(fewer.claimTypes).toEqual(['partner_no'])
      expect(await events('client.claim_types.set', 'app')).toHaveLength(2)
    })

    it('refuses an unknown claim type or client', async () => {
      const unknownType = await failure(database.db.transaction((tx) => setClientClaimTypes(tx, context, 'app', ['nope'])))
      expect(unknownType.kind).toBe('invalid')

      const unknownClient = await failure(database.db.transaction((tx) => setClientClaimTypes(tx, context, 'ghost', [])))
      expect(unknownClient.kind).toBe('not_found')
    })
  })
})
