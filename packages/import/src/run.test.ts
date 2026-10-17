import { describe, expect, it } from 'vitest'
import { ImportFileError } from './errors.js'
import { runImport } from './run.js'
import { FakeApi } from './testing.js'

const csv = (...lines: string[]) => new TextEncoder().encode(lines.join('\n') + '\n')
const HEADER = 'email,first_name,last_name,partner_no'
const options = (extra: Partial<Parameters<typeof runImport>[2]> = {}) => ({ dryRun: false, ...extra })

describe('running an import', () => {
  describe('users', () => {
    it('creates new users, updates changed ones and leaves identical ones alone', async () => {
      const api = new FakeApi()
      api.seed('same@example.com', { firstName: 'Same', lastName: 'Same', claims: { partner_no: ['00001'] } })
      api.seed('changed@example.com', { firstName: 'Old', lastName: 'Name' })

      const report = await runImport(csv(HEADER, 'new@example.com,New,One,00002', 'same@example.com,Same,Same,00001', 'changed@example.com,New,Name,'), api, options())

      expect(report.counts).toEqual({ created: 1, updated: 1, unchanged: 1, rejected: 0, failed: 0 })
      expect(report.totalRows).toBe(3)
      expect(report.rows.map((row) => [row.line, row.outcome])).toEqual([[2, 'created'], [4, 'updated']])
      expect(api.users.get('new@example.com')).toMatchObject({ firstName: 'New', claims: { partner_no: ['00002'] } })
      expect(api.users.get('changed@example.com')!.firstName).toBe('New')
    })

    it('says a second run of the same file changes nothing', async () => {
      const api = new FakeApi()
      const file = csv(HEADER, 'a@example.com,A,One,00001', 'b@example.com,B,Two,00002;00003')

      await runImport(file, api, options())
      const again = await runImport(file, api, options())

      expect(again.counts).toEqual({ created: 0, updated: 0, unchanged: 2, rejected: 0, failed: 0 })
      expect(again.rows).toEqual([])
    })

    it('sends only what the file holds: no claims without claim columns, no phone without a phone column', async () => {
      const api = new FakeApi()

      await runImport(csv('email,first_name,last_name', 'a@example.com,A,B'), api, options())

      expect(api.bodies[0]).toEqual({ firstName: 'A', lastName: 'B' })
    })
  })

  describe('dry run', () => {
    it('reports what would happen and changes nothing', async () => {
      const api = new FakeApi()
      api.seed('changed@example.com', { firstName: 'Old', lastName: 'Name' })

      const report = await runImport(csv(HEADER, 'new@example.com,New,One,00002', 'changed@example.com,New,Name,00005'), api, options({ dryRun: true }))

      expect(report.dryRun).toBe(true)
      expect(report.counts).toMatchObject({ created: 1, updated: 1 })
      expect(report.rows[1]!.changes).toEqual({ profile: { firstName: { from: 'Old', to: 'New' } }, claims: { partner_no: { from: [], to: ['00005'] } } })
      expect(api.users.has('new@example.com')).toBe(false)
      expect(api.users.get('changed@example.com')!.firstName).toBe('Old')
    })
  })

  describe('rows that cannot be imported', () => {
    it('rejects rows with their line and reason, imports the others, and keeps the cells for a rejected-rows file', async () => {
      const api = new FakeApi()

      const report = await runImport(csv(HEADER, 'good@example.com,Good,One,00001', 'broken,Bad,Two,00002', 'also-good@example.com,Good,Three,abc'), api, options())

      expect(report.counts).toMatchObject({ created: 1, rejected: 2 })
      expect(report.rejectedRows.map((row) => [row.line, row.fields[0], row.reasons[0]])).toEqual([
        [3, 'broken', '"broken" is not a valid e-mail address.'],
        [4, 'also-good@example.com', 'partner_no: "abc" does not match the pattern ^[0-9]{5}$.'],
      ])
      expect(api.users.has('good@example.com')).toBe(true)
    })

    it('rejects a row the server refuses, with the server\'s reason', async () => {
      const api = new FakeApi()
      api.serverRejects.add('odd@example.com')

      const report = await runImport(csv(HEADER, 'odd@example.com,Odd,One,00001', 'fine@example.com,Fine,One,00002'), api, options())

      expect(report.counts).toMatchObject({ created: 1, rejected: 1 })
      expect(report.rejectedRows[0]).toMatchObject({ line: 2, reasons: ['/claims/partner_no: the server says no'], fields: ['odd@example.com', 'Odd', 'One', '00001'] })
    })

    it('counts a row as failed, not rejected, when the API cannot be reached, and carries on', async () => {
      const api = new FakeApi()
      api.unreachable.add('down@example.com')

      const report = await runImport(csv(HEADER, 'down@example.com,Down,One,00001', 'up@example.com,Up,Two,00002'), api, options())

      expect(report.counts).toMatchObject({ created: 1, failed: 1, rejected: 0 })
      expect(report.rows.find((row) => row.outcome === 'failed')).toMatchObject({ line: 2, email: 'down@example.com', reasons: ['Cannot reach the API: socket hang up'] })
      expect(report.rejectedRows).toEqual([])
    })

    it('stops at once when the API refuses the client, instead of failing every row', async () => {
      const api = new FakeApi()
      api.refuseWith = 403

      const lines = Array.from({ length: 50 }, (_, index) => `u${index}@example.com,U,${index},00001`)
      await expect(runImport(csv(HEADER, ...lines), api, options({ concurrency: 2 }))).rejects.toThrow(/refused the import \(HTTP 403\).*"directory" scope/)
      expect(api.calls.upsert).toBeLessThan(10)
    })
  })

  describe('files that cannot be imported', () => {
    it('aborts on an unknown column before the first write', async () => {
      const api = new FakeApi()

      await expect(runImport(csv('email,first_name,last_name,partnr_no', 'a@example.com,A,B,00001'), api, options())).rejects.toThrow(/did you mean "partner_no"/)
      expect(api.calls.upsert).toBe(0)
      expect(api.calls.list).toBe(0)
    })

    it('skips unknown columns with a warning when asked to', async () => {
      const api = new FakeApi()

      const report = await runImport(csv('email,first_name,last_name,shoe_size', 'a@example.com,A,B,42'), api, options({ ignoreUnknownColumns: true }))

      expect(report.warnings).toEqual(['The column "shoe_size" is not a claim type and was ignored.'])
      expect(report.counts.created).toBe(1)
    })

    it('reads a semicolon file with the value separator inside quotes', async () => {
      const api = new FakeApi()

      const report = await runImport(csv('email;first_name;last_name;partner_no', 'a@example.com;A;B;"00001;00002"'), api, options())

      expect(report.delimiter).toBe(';')
      expect(api.users.get('a@example.com')!.claims.partner_no).toEqual(['00001', '00002'])
    })
  })

  describe('users who are not in the file', () => {
    const crowd = (api: FakeApi, count = 10) => Array.from({ length: count }, (_, index) => api.seed(`u${index}@example.com`))
    const fileWith = (names: string[], extra: string[] = []) => csv(HEADER, ...names.map((name) => `${name}@example.com,${name},X,`), ...extra)
    const everyoneBut = (...gone: string[]) => Array.from({ length: 10 }, (_, index) => `u${index}`).filter((name) => !gone.includes(name))

    it('ignores them by default and never even lists the users', async () => {
      const api = new FakeApi()
      crowd(api)

      const report = await runImport(fileWith(['u0']), api, options())

      expect(api.calls.list).toBe(0)
      expect(report.missing).toMatchObject({ mode: 'ignore', locked: [], deleted: [] })
      expect([...api.users.values()].every((user) => user.status === 'active')).toBe(true)
    })

    it('locks them, but not administrators, not rejected rows, and not those already locked', async () => {
      const api = new FakeApi()
      crowd(api)
      api.seed('root@example.com', { isAdmin: true })
      api.seed('already@example.com', { status: 'locked' })
      // u1 is in the file, but its row is rejected (bad claim): it must not be locked.
      const file = csv(HEADER, ...everyoneBut('u1', 'u2').map((name) => `${name}@example.com,${name},X,`), 'u1@example.com,u1,X,abc')

      const report = await runImport(file, api, options({ missing: 'lock', maxMissingPercent: 100 }))

      expect(report.missing.locked).toEqual(['u2@example.com'])
      expect(report.missing.skipped).toEqual([{ email: 'already@example.com', reason: 'already locked' }])
      expect(api.users.get('u2@example.com')!.status).toBe('locked')
      expect(api.users.get('u1@example.com')!.status).toBe('active')
      expect(api.users.get('root@example.com')!.status).toBe('active')
      expect(report.counts.rejected).toBe(1)
    })

    it('refuses before the first write when too many users would be locked', async () => {
      const api = new FakeApi()
      crowd(api)

      await expect(runImport(fileWith(['u0', 'u1', 'u2', 'u3', 'u4']), api, options({ missing: 'lock' }))).rejects.toThrow(/5 of 10 users \(50\.0%\).*more than the allowed 20%/s)
      expect(api.calls.upsert).toBe(0)
      expect(api.calls.lock).toBe(0)
    })

    it('goes ahead past the limit with force', async () => {
      const api = new FakeApi()
      crowd(api)

      const report = await runImport(fileWith(['u0', 'u1', 'u2', 'u3', 'u4']), api, options({ missing: 'lock', force: true }))

      expect(report.missing.locked).toHaveLength(5)
    })

    it('refuses a file without a valid row', async () => {
      const api = new FakeApi()
      crowd(api)

      await expect(runImport(csv(HEADER), api, options({ missing: 'lock', force: true }))).rejects.toThrow(/no valid rows/)
      expect(api.calls.lock).toBe(0)
    })

    it('deletes only with --allow-delete', async () => {
      const api = new FakeApi()
      crowd(api)

      await expect(runImport(fileWith(everyoneBut('u9')), api, options({ missing: 'delete' }))).rejects.toThrow(/--allow-delete/)
      const report = await runImport(fileWith(everyoneBut('u9')), api, options({ missing: 'delete', allowDelete: true }))

      expect(report.missing.deleted).toEqual(['u9@example.com'])
      expect(api.users.has('u9@example.com')).toBe(false)
    })

    it('only says who would be locked in a dry run', async () => {
      const api = new FakeApi()
      crowd(api)

      const report = await runImport(fileWith(everyoneBut('u9')), api, options({ missing: 'lock', dryRun: true }))

      expect(report.missing.locked).toEqual(['u9@example.com'])
      expect(api.calls.lock).toBe(0)
      expect(api.users.get('u9@example.com')!.status).toBe('active')
    })
  })

  describe('behaviour', () => {
    it('keeps at most the configured number of requests in flight, and does use the parallelism', async () => {
      const api = new FakeApi()
      const lines = Array.from({ length: 40 }, (_, index) => `u${index}@example.com,U,${index},00001`)

      await runImport(csv(HEADER, ...lines), api, options({ concurrency: 4 }))

      expect(api.maxInFlight).toBeLessThanOrEqual(4)
      expect(api.maxInFlight).toBeGreaterThan(1)
    })

    it('reports progress for the users and for the missing users', async () => {
      const api = new FakeApi()
      Array.from({ length: 10 }, (_, index) => api.seed(`u${index}@example.com`))
      const seen: string[] = []

      await runImport(csv(HEADER, 'u0@example.com,A,B,', 'u1@example.com,A,B,', 'u2@example.com,A,B,', 'u3@example.com,A,B,', 'u4@example.com,A,B,', 'u5@example.com,A,B,', 'u6@example.com,A,B,', 'u7@example.com,A,B,', 'u8@example.com,A,B,'), api, options({
        missing: 'lock',
        onProgress: ({ phase, done, total }) => void seen.push(`${phase} ${done}/${total}`),
      }))

      expect(seen[0]).toBe('users 1/9')
      expect(seen).toContain('users 9/9')
      expect(seen.at(-1)).toBe('missing 1/1')
    })

    it('says how long it took', async () => {
      const report = await runImport(csv(HEADER, 'a@example.com,A,B,'), new FakeApi(), options())

      expect(report.durationMs).toBeGreaterThanOrEqual(0)
    })
  })

  it('does not hide a problem with the claim types: an API error there stops the import', async () => {
    const api = new FakeApi()
    api.claimTypes = async () => {
      throw new ImportFileError('The API refused: no token.')
    }

    await expect(runImport(csv(HEADER, 'a@example.com,A,B,'), api, options())).rejects.toThrow('The API refused: no token.')
  })
})
