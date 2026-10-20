import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AdminError } from './errors.js'
import { deactivateUser, lockUser } from './lifecycle.js'
import { createUser, deleteUser, findUserById, type RequestContext, updateUser } from './users.js'
import { createTestDatabase, hasDatabase } from '../test/test-database.js'

const machine: RequestContext = { actor: { type: 'client', id: 'ops' }, ip: '203.0.113.7', userAgent: 'vitest' }
const person = (id: string): RequestContext => ({ actor: { type: 'user', id }, ip: '203.0.113.8', userAgent: 'vitest' })

describe.skipIf(!hasDatabase)('keeping somebody able to administer', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>
  let counter = 0

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  afterAll(async () => {
    await database?.drop()
  })

  const make = async (isAdmin: boolean, status: 'active' | 'locked' = 'active') => {
    const user = await database.db.transaction((tx) => createUser(tx, machine, { email: `adm${++counter}@example.com`, firstName: 'A', lastName: `${counter}` }))
    await database.pool.query(`update users set is_admin = $1, status = $2, password_hash = 'hash' where id = $3`, [isAdmin, status, user.id])
    return (await findUserById(database.db, user.id))!
  }
  /** Leaves exactly the given administrators active. */
  const onlyAdmins = async (...keep: { id: string }[]) => {
    await database.pool.query(`update users set status = 'locked' where is_admin and status = 'active' and id <> all($1)`, [keep.map((user) => user.id)])
  }

  const actions = {
    lock: (user: Awaited<ReturnType<typeof make>>, context: RequestContext = machine) => database.db.transaction((tx) => lockUser(tx, context, user)),
    deactivate: (user: Awaited<ReturnType<typeof make>>, context: RequestContext = machine) => database.db.transaction((tx) => deactivateUser(tx, context, user)),
    delete: (user: Awaited<ReturnType<typeof make>>, context: RequestContext = machine) => database.db.transaction((tx) => deleteUser(tx, context, user)),
    demote: (user: Awaited<ReturnType<typeof make>>, context: RequestContext = machine) => database.db.transaction((tx) => updateUser(tx, context, user, { isAdmin: false })),
  }

  it.each(['lock', 'deactivate', 'delete', 'demote'] as const)('refuses to %s the last active administrator, and changes nothing', async (action) => {
    const only = await make(true)
    await onlyAdmins(only)

    const error = await actions[action](only).catch((caught) => caught)
    expect(error).toBeInstanceOf(AdminError)
    expect(error).toMatchObject({ kind: 'conflict' })
    expect(error.message).toMatch(/last active administrator/)

    const after = (await findUserById(database.db, only.id))!
    expect(after).toMatchObject({ isAdmin: true, status: 'active' })
  })

  it.each(['lock', 'deactivate', 'delete', 'demote'] as const)('allows %s when another administrator remains active', async (action) => {
    const one = await make(true)
    const two = await make(true)
    await onlyAdmins(one, two)

    await expect(actions[action](one)).resolves.not.toThrow()
  })

  it.each(['lock', 'deactivate', 'delete', 'demote'] as const)('refuses a person to %s themselves, even with others around', async (action) => {
    const me = await make(true)
    await make(true)

    const error = await actions[action](me, person(me.id)).catch((caught) => caught)
    expect(error).toBeInstanceOf(AdminError)
    expect(error.message).toMatch(/cannot .* yourself/)
    expect((await findUserById(database.db, me.id))!).toMatchObject({ isAdmin: true, status: 'active' })
  })

  it('lets a person do these things to somebody else', async () => {
    const me = await make(true)
    const other = await make(true)
    await onlyAdmins(me, other)
    await expect(actions.lock(other, person(me.id))).resolves.toBeDefined()
  })

  it('does not care about people who are not administrators', async () => {
    const only = await make(true)
    await onlyAdmins(only)
    const plain = await make(false)
    await expect(actions.lock(plain)).resolves.toBeDefined()
    const another = await make(false)
    await expect(actions.delete(another, person(only.id))).resolves.toBeUndefined()
  })

  it('lets an administrator who is already locked be demoted or deleted, as nobody relies on them', async () => {
    const active = await make(true)
    const locked = await make(true, 'locked')
    await onlyAdmins(active)
    await expect(actions.demote(locked)).resolves.toBeDefined()
    const another = await make(true, 'locked')
    await expect(actions.delete(another)).resolves.toBeUndefined()
  })

  it('does not stop other changes to the last administrator', async () => {
    const only = await make(true)
    await onlyAdmins(only)
    const updated = await database.db.transaction((tx) => updateUser(tx, machine, only, { firstName: 'Renamed' }))
    expect(updated.user.firstName).toBe('Renamed')
    expect(updated.user.isAdmin).toBe(true)
  })

  it('lets only one of two administrators demote the other when they try at the same moment', async () => {
    const a = await make(true)
    const b = await make(true)
    await onlyAdmins(a, b)

    const results = await Promise.allSettled([actions.demote(a, person(b.id)), actions.demote(b, person(a.id))])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const { rows } = await database.pool.query(`select count(*) from users where is_admin and status = 'active'`)
    expect(Number(rows[0].count)).toBe(1)
  })
})
