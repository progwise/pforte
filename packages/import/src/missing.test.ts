import { describe, expect, it } from 'vitest'
import type { ApiUser } from './api.js'
import { ImportFileError } from './errors.js'
import { type MissingOptions, planMissing } from './missing.js'

const user = (name: string, extra: Partial<ApiUser> = {}): ApiUser => ({ id: `id-${name}`, email: `${name}@example.com`, status: 'active', isAdmin: false, ...extra })
const present = (...names: string[]) => new Set(names.map((name) => `${name}@example.com`))
const options = (extra: Partial<MissingOptions> = {}): MissingOptions => ({ mode: 'lock', allowDelete: false, maxMissingPercent: 20, force: false, ...extra })
const emails = (users: ApiUser[]) => users.map((u) => u.email.split('@')[0])

// Ten regular users, so one missing user is 10%.
const crowd = Array.from({ length: 10 }, (_, index) => user(`u${index}`))
const allBut = (...names: string[]) => present(...crowd.map((u) => u.email.split('@')[0]!).filter((name) => !names.includes(name)))

describe('planning for users who are not in the file', () => {
  it('does nothing in ignore mode, not even looking at the users', () => {
    expect(planMissing(crowd, present(), 0, options({ mode: 'ignore' }))).toEqual({ toLock: [], toDelete: [], skipped: [] })
  })

  it('locks the users who are missing', () => {
    const plan = planMissing(crowd, allBut('u3'), 9, options())

    expect(emails(plan.toLock)).toEqual(['u3'])
    expect(plan.toDelete).toEqual([])
  })

  it('never touches an administrator, even if the admin is not in the file', () => {
    const users = [...crowd, user('root', { isAdmin: true })]

    const plan = planMissing(users, allBut('u1'), 9, options())

    expect(emails(plan.toLock)).toEqual(['u1'])
  })

  it('finds the user whatever the case of the e-mail address', () => {
    const users = [...crowd.slice(0, 9), { ...user('u9'), email: 'U9@Example.COM' }]

    // The file has u9@example.com in lower case, the user is stored as U9@Example.COM: the same person.
    expect(planMissing(users, allBut(), 9, options()).toLock).toEqual([])
    expect(planMissing(users, allBut('u9'), 9, options()).toLock).toHaveLength(1)
  })

  it('leaves users alone who are already locked or deactivated, and says why', () => {
    const users = [...crowd.slice(0, 8), user('locked', { status: 'locked' }), user('gone', { status: 'deactivated' })]

    const plan = planMissing(users, allBut('locked', 'gone'), 8, options({ maxMissingPercent: 100 }))

    expect(plan.toLock).toEqual([])
    expect(plan.skipped.map((s) => s.reason).sort()).toEqual(['already deactivated', 'already locked'])
  })

  it('locks users who never finished activation', () => {
    const users = [...crowd.slice(0, 9), user('new', { status: 'created' })]

    expect(emails(planMissing(users, allBut('new'), 9, options()).toLock)).toEqual(['new'])
  })

  describe('delete', () => {
    it('needs --allow-delete and points to lock as the reversible choice', () => {
      expect(() => planMissing(crowd, allBut('u3'), 9, options({ mode: 'delete' }))).toThrow(/--allow-delete.*--missing=lock/)
    })

    it('deletes every missing regular user, whatever their status', () => {
      const users = [...crowd.slice(0, 9), user('locked', { status: 'locked' })]

      const plan = planMissing(users, allBut('locked'), 9, options({ mode: 'delete', allowDelete: true }))

      expect(emails(plan.toDelete)).toEqual(['locked'])
      expect(plan.toLock).toEqual([])
    })
  })

  describe('guards', () => {
    it('refuses to affect more than the allowed share of users, naming the numbers', () => {
      const attempt = () => planMissing(crowd, allBut('u1', 'u2', 'u3'), 7, options())

      expect(attempt).toThrow(ImportFileError)
      expect(attempt).toThrow(/3 of 10 users \(30\.0%\).*locked.*more than the allowed 20%.*truncated/s)
    })

    it('allows exactly the limit', () => {
      expect(planMissing(crowd, allBut('u1', 'u2'), 8, options()).toLock).toHaveLength(2)
    })

    it('can be raised or overridden, and the share counts only regular users', () => {
      expect(planMissing(crowd, allBut('u1', 'u2', 'u3'), 7, options({ maxMissingPercent: 30 })).toLock).toHaveLength(3)
      expect(planMissing(crowd, allBut('u1', 'u2', 'u3'), 7, options({ force: true })).toLock).toHaveLength(3)
      const withAdmins = [...crowd, user('a1', { isAdmin: true }), user('a2', { isAdmin: true })]
      expect(() => planMissing(withAdmins, allBut('u1', 'u2', 'u3'), 7, options())).toThrow(/3 of 10 users/)
    })

    it('does not count users who are skipped as already locked', () => {
      const users = [...crowd.slice(0, 5), ...Array.from({ length: 5 }, (_, index) => user(`l${index}`, { status: 'locked' }))]

      const plan = planMissing(users, present('u0', 'u1', 'u2', 'u3'), 4, options())

      expect(emails(plan.toLock)).toEqual(['u4'])
    })

    it('refuses a file without a valid row, even with --force, because that would affect everyone', () => {
      expect(() => planMissing(crowd, present(), 0, options({ force: true }))).toThrow(/no valid rows.*every user/)
    })

    it('has nothing to guard when there are no regular users', () => {
      expect(planMissing([user('root', { isAdmin: true })], present('x'), 1, options())).toEqual({ toLock: [], toDelete: [], skipped: [] })
    })
  })
})
