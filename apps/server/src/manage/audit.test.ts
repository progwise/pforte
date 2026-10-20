import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { Browser } from '../test/browser.js'
import { signedInToManage } from '../test/manage-session.js'

describe.skipIf(!hasDatabase)('the administration: audit log', () => {
  let h: AdminHarness
  let browser: Browser
  let adminId: string
  let benId: string

  beforeAll(async () => {
    h = await createAdminHarness()
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(async () => {
    await h.database.pool.query('delete from rate_limits')
    await h.database.pool.query('delete from otp_codes')
    await h.database.pool.query(`delete from audit_events where action like 'zz.%'`)
    await h.database.pool.query(
      `update users set first_name = 'Ada', last_name = 'Admin', is_admin = true, status = 'active', language = 'en' where email = 'admin@example.com'`,
    )
    await h.database.pool.query(`update users set first_name = 'Ben', last_name = 'Keller', status = 'active' where email = 'ben.keller@example.com'`)
    browser = await signedInToManage(h, Browser)
    adminId = (await h.database.pool.query(`select id from users where email = 'admin@example.com'`)).rows[0].id
    benId = (await h.database.pool.query(`select id from users where email = 'ben.keller@example.com'`)).rows[0].id
  })

  const get = (url: string) => browser.request('GET', url)
  const plain = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '')
  const event = (e: { action: string; actorType?: string; actorId?: string | null; targetType?: string | null; targetId?: string | null; details?: object; ip?: string; at?: string; userAgent?: string }) =>
    h.database.pool.query(
      `insert into audit_events (actor_type, actor_id, action, target_type, target_id, details, ip, user_agent, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::timestamptz, now()))`,
      [e.actorType ?? 'user', e.actorId === undefined ? adminId : e.actorId, e.action, e.targetType === undefined ? 'user' : e.targetType, e.targetId === undefined ? benId : e.targetId, JSON.stringify(e.details ?? {}), e.ip ?? '203.0.113.5', e.userAgent ?? null, e.at ?? null],
    )
  const rowsOf = (html: string) => (plain(html).match(/<(?:details|div) class="event"/g) ?? []).length

  it('is closed to somebody who is not signed in', async () => {
    const response = await new Browser(h.app).request('GET', '/manage/audit')
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/manage/login?next=%2Fmanage%2Faudit')
  })

  it('shows who did what to whom, with names, the action, the address and the details', async () => {
    await event({ action: 'zz.lock', details: { from: 'active', to: 'locked' }, userAgent: 'TestBrowser/1.0' })

    const page = plain((await get('/manage/audit?action=zz.*')).body)

    expect(page).toContain('<h1>Audit log</h1>')
    expect(page).toMatch(/<a href="\/manage\/users\/[^"]+">Ada Admin<\/a><br><small class="muted">admin@example.com<\/small>/)
    expect(page).toContain('<code>zz.lock</code>')
    expect(page).toContain('Ben Keller')
    expect(page).toContain('203.0.113.5')
    expect(page).toMatch(/<details class="event">[\s\S]*?<\/summary>\s*<div class="body"><pre>[\s\S]*&quot;to&quot;: &quot;locked&quot;/)
    expect(page).toContain('Browser: TestBrowser/1.0')
    expect(page).toContain('aria-current="page">Audit log</a>')
  })

  it('shows seconds, in the time zone of the installation', async () => {
    await event({ action: 'zz.time', at: '2030-06-01T10:30:15Z' })

    expect(plain((await get('/manage/audit?action=zz.time')).body)).toContain('12:30:15')
  })

  it('names clients and the system, and says when nobody was signed in', async () => {
    await event({ action: 'zz.client', actorType: 'client', actorId: 'demo-import', targetType: 'client', targetId: 'demo-web' })
    await event({ action: 'zz.system', actorType: 'system', actorId: null, targetType: null, targetId: null })
    await event({ action: 'zz.anonymous', actorType: 'user', actorId: null, targetType: null, targetId: null })

    const page = plain((await get('/manage/audit?action=zz.*')).body)

    expect(page).toContain('<code>demo-import</code>')
    expect(page).toContain('href="/manage/clients/demo-web"')
    expect(page).toContain('pforte itself')
    expect(page).toContain('not signed in')
  })

  it('knows a person who was deleted only from the event, and says so', async () => {
    const gone = '00000000-0000-4000-8000-0000000000aa'
    await event({ action: 'zz.delete', targetId: gone, details: { email: 'gone@example.com' } })

    const page = plain((await get('/manage/audit?action=zz.*')).body)

    expect(page).toContain('gone@example.com <span class="muted">(deleted)</span>')
  })

  describe('filters', () => {
    beforeEach(async () => {
      await event({ action: 'zz.alpha.one' })
      await event({ action: 'zz.alpha.two', targetId: adminId })
      await event({ action: 'zz.beta', actorType: 'client', actorId: 'demo-import' })
    })

    it('by an exact action, or by the start of one', async () => {
      expect(rowsOf((await get('/manage/audit?action=zz.alpha.one')).body)).toBe(1)
      expect(rowsOf((await get('/manage/audit?action=zz.alpha.*')).body)).toBe(2)
      expect(rowsOf((await get('/manage/audit?action=zz.*')).body)).toBe(3)
    })

    it('by the person it was about, found by e-mail address in any case', async () => {
      const page = await get(`/manage/audit?${new URLSearchParams({ user: 'BEN.Keller@example.com', action: 'zz.*' })}`)

      expect(rowsOf(page.body)).toBe(2)
      expect(plain(page.body)).not.toContain('zz.alpha.two')
    })

    it('by who did it: a person by e-mail address, a client by ID', async () => {
      expect(rowsOf((await get(`/manage/audit?${new URLSearchParams({ actor: 'admin@example.com', action: 'zz.*' })}`)).body)).toBe(2)
      expect(plain((await get('/manage/audit?actor=demo-import&action=zz.*')).body)).toContain('zz.beta')
      expect(rowsOf((await get('/manage/audit?actor=demo-import&action=zz.*')).body)).toBe(1)
    })

    it('says so when no person has the address, and shows no events', async () => {
      const page = plain((await get('/manage/audit?user=nobody@example.com')).body)

      expect(page).toContain('No person has the e-mail address nobody@example.com.')
      expect(rowsOf(page)).toBe(0)
      expect(page).not.toContain('No events match.')
    })

    it('says so when nothing matches', async () => {
      expect(plain((await get('/manage/audit?action=zz.nothing')).body)).toContain('No events match.')
    })

    it('by day, counted in the time zone of the installation', async () => {
      // 22:30 UTC on 1 June is half past midnight on 2 June in Berlin
      await event({ action: 'zz.late', at: '2030-06-01T22:30:00Z' })

      expect(rowsOf((await get('/manage/audit?action=zz.late&from=2030-06-02&to=2030-06-02')).body)).toBe(1)
      expect(plain((await get('/manage/audit?action=zz.late&from=2030-06-01&to=2030-06-01')).body)).toContain('No events match.')
      expect(plain((await get('/manage/audit?action=zz.late&from=2030-06-03')).body)).toContain('No events match.')
      expect(rowsOf((await get('/manage/audit?action=zz.late&to=2030-06-02')).body)).toBe(1)
    })

    it('ignores a date that is not one, and keeps what was typed', async () => {
      const page = await get('/manage/audit?action=zz.*&from=yesterday&to=2030-02-31')

      expect(rowsOf(page.body)).toBe(3)
      expect(page.body).toContain('name="action" type="search" value="zz.*"')
    })

    it('offers the known actions as suggestions', async () => {
      const page = (await get('/manage/audit')).body

      expect(page).toContain('<datalist id="known-actions">')
      expect(page).toContain('<option value="user.lock">')
    })
  })

  describe('paging', () => {
    it('shows 50 at a time, newest first, and a link to older events that keeps the filters', async () => {
      for (let n = 1; n <= 55; n++) await event({ action: 'zz.page', details: { n } })

      const first = await get('/manage/audit?action=zz.page')
      expect(rowsOf(first.body)).toBe(50)
      expect(plain(first.body)).toContain('&quot;n&quot;: 55')
      const older = /href="([^"]+)"[^>]*>Older events/.exec(first.body)?.[1]?.replaceAll('&amp;', '&')
      expect(older).toMatch(/action=zz\.page&cursor=/)

      const second = await get(older!)
      expect(rowsOf(second.body)).toBe(5)
      expect(plain(second.body)).toContain('&quot;n&quot;: 1\n')
      expect(second.body).not.toContain('Older events')
    })

    it('ignores a cursor that is not one', async () => {
      await event({ action: 'zz.page' })

      expect(rowsOf((await get('/manage/audit?action=zz.page&cursor=nonsense')).body)).toBe(1)
    })
  })

  it('shows what the administration itself did, under the name of the person who did it', async () => {
    await browser.request('POST', `/manage/users/${benId}/lock`, { form: {} })

    const page = plain((await get(`/manage/audit?${new URLSearchParams({ user: 'ben.keller@example.com', action: 'user.lock' })}`)).body)

    expect(page).toContain('<code>user.lock</code>')
    expect(page).toContain('Ada Admin')
  })

  it('escapes what an event holds', async () => {
    await event({ action: 'zz.xss', details: { note: '<script>alert(1)</script>' }, userAgent: '<img src=x onerror=alert(1)>' })

    const page = plain((await get('/manage/audit?action=zz.xss')).body)

    expect(page).not.toContain('<script>alert(1)')
    expect(page).not.toContain('<img src=x')
    expect(page).toContain('&lt;script&gt;alert(1)')
  })

  it('is reachable from the page of a person', async () => {
    const page = (await get(`/manage/users/${benId}`)).body

    expect(page).toContain('href="/manage/audit?user=ben.keller%40example.com"')
  })

  it('shows the texts in German for an administrator who uses German', async () => {
    await h.database.pool.query(`update users set language = 'de' where email = 'admin@example.com'`)
    browser = await signedInToManage(h, Browser)

    const page = (await get('/manage/audit')).body

    expect(page).toContain('Audit-Protokoll')
    expect(page).toContain('Ereignisse anzeigen')
  })
})
