import { readFileSync } from 'node:fs'
import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { Browser, type Multipart } from '../test/browser.js'
import { signedInToManage } from '../test/manage-session.js'

describe.skipIf(!hasDatabase)('the administration: import', () => {
  let h: AdminHarness
  let browser: Browser
  let adminId: string

  beforeAll(async () => {
    h = await createAdminHarness()
    await h.database.pool.query(`insert into claim_types (key, description, value_pattern, multi_valued) values ('imp_team', 'Team', '^[A-Z]{3}$', false), ('imp_region', 'Regions', null, true) on conflict do nothing`)
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(async () => {
    await h.database.pool.query('delete from rate_limits')
    await h.database.pool.query('delete from otp_codes')
    await h.database.pool.query(`delete from users where email like 'imp-%@example.com'`)
    await h.database.pool.query(`delete from audit_events where action like 'zz.%'`)
    await h.database.pool.query(
      `update users set first_name = 'Ada', last_name = 'Admin', is_admin = true, status = 'active', language = 'en' where email = 'admin@example.com'`,
    )
    await h.database.pool.query(`update users set status = 'active' where not is_admin and password_hash is not null`)
    browser = await signedInToManage(h, Browser)
    adminId = (await h.database.pool.query(`select id from users where email = 'admin@example.com'`)).rows[0].id
  })

  const get = (url: string) => browser.request('GET', url)
  const plain = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '')
  const upload = (csv: string | Buffer, fields: Record<string, string> = {}, who: Browser = browser) =>
    who.request('POST', '/manage/import', { multipart: { fields, file: { name: 'users.csv', content: csv } } satisfies Multipart })
  const tokenOf = (html: string) => /name="token" value="([^"]+)"/.exec(html)?.[1]
  const apply = (token: string | undefined, who: Browser = browser) => who.request('POST', '/manage/import/apply', { form: { token: token ?? '' } })
  const userRow = async (email: string) => (await h.database.pool.query(`select * from users where email = $1`, [email])).rows[0]
  const claimsOf = async (email: string) =>
    (await h.database.pool.query(`select claim_type_key, value from user_claims c join users u on u.id = c.user_id where u.email = $1 order by 1, 2`, [email])).rows.map((r) => `${r.claim_type_key}=${r.value}`)
  const CSV = 'email,first_name,last_name,imp_team,imp_region\r\nimp-ann@example.com,Ann,Lee,MUC,north;south\r\nimp-bob@example.com,Bob,Ray,BER,\r\n'

  it('is closed to somebody who is not signed in', async () => {
    const anonymous = new Browser(h.app)
    expect((await anonymous.request('GET', '/manage/import')).statusCode).toBe(303)
    expect((await upload(CSV, {}, anonymous)).statusCode).toBe(303)
  })

  it('refuses a form post that comes from another site', async () => {
    const response = await browser.request('POST', '/manage/import', { multipart: { file: { name: 'a.csv', content: CSV } }, headers: { 'sec-fetch-site': 'cross-site' } })

    expect(response.statusCode).toBe(403)
    expect(await userRow('imp-ann@example.com')).toBeUndefined()
  })

  it('shows the form with what the file needs to look like', async () => {
    const page = plain((await get('/manage/import')).body)

    expect(page).toContain('<h1>Import users</h1>')
    expect(page).toContain('Needed: email, first_name, last_name.')
    expect(page).toContain('enctype="multipart/form-data"')
    expect(page).toContain('type="file"')
    expect(page).toContain('aria-current="page">Import</a>')
  })

  describe('checking the file', () => {
    it('writes nothing, says what would happen, and offers to import', async () => {
      const page = plain((await upload(CSV)).body)

      expect(page).toContain('Checked: nothing has been written')
      expect(page).toContain('Rows in the file: 2.')
      expect(page).toContain('<dt>2</dt><dd>would be created</dd>')
      expect(page).toContain('imp-ann@example.com')
      expect(page).toContain('new person')
      expect(page).toContain('action="/manage/import/apply"')
      expect(await userRow('imp-ann@example.com')).toBeUndefined()
      expect((await h.database.pool.query(`select 1 from audit_events where action = 'user.create' and details->>'email' like 'imp-%'`)).rowCount).toBe(0)
    })

    it('is not kept by the browser', async () => {
      expect((await upload(CSV)).headers['cache-control']).toBe('no-store')
    })

    it('says what would change for people who exist', async () => {
      await upload(CSV).then((page) => apply(tokenOf(page.body)))

      const page = plain((await upload('email,first_name,last_name\r\nimp-ann@example.com,Ann,Smith\r\n')).body)

      expect(page).toMatch(/would be updated/)
      expect(page).toContain('lastName: Lee → Smith')
    })

    it('says so when the file changes nothing, without an import button', async () => {
      await upload(CSV).then((page) => apply(tokenOf(page.body)))

      const page = plain((await upload(CSV)).body)

      expect(page).toContain('The file changes nothing.')
      expect(page).not.toContain('action="/manage/import/apply"')
    })
  })

  describe('importing', () => {
    it('creates the people with their claims, as the person who is signed in', async () => {
      const checked = await upload(CSV)

      const done = await apply(tokenOf(checked.body))

      expect(done.statusCode).toBe(200)
      expect(plain(done.body)).toContain('Import finished in')
      expect(await userRow('imp-ann@example.com')).toMatchObject({ first_name: 'Ann', last_name: 'Lee', status: 'created' })
      expect(await claimsOf('imp-ann@example.com')).toEqual(['imp_region=north', 'imp_region=south', 'imp_team=MUC'])
      expect(await claimsOf('imp-bob@example.com')).toEqual(['imp_team=BER'])
      const { rows } = await h.database.pool.query(`select actor_type, actor_id from audit_events where action = 'user.create' and details->>'email' = 'imp-ann@example.com'`)
      expect(rows[0]).toMatchObject({ actor_type: 'user', actor_id: adminId })
    })

    it('imports the file that was checked, once: the file is let go of afterwards', async () => {
      const token = tokenOf((await upload(CSV)).body)

      await apply(token)
      const again = await apply(token)

      expect(again.statusCode).toBe(410)
      expect(again.body).toContain('no longer kept')
    })

    it('does not run a file twice when "Import now" is pressed twice at once', async () => {
      const token = tokenOf((await upload(CSV)).body)

      const [one, two] = await Promise.all([apply(token), apply(token)])

      expect([one.statusCode, two.statusCode].sort()).toEqual([200, 410])
    })

    it('updates people who exist and counts the unchanged ones', async () => {
      await apply(tokenOf((await upload(CSV)).body))

      const done = plain((await apply(tokenOf((await upload('email,first_name,last_name,imp_team\r\nimp-ann@example.com,Ann,Smith,MUC\r\nimp-bob@example.com,Bob,Ray,BER\r\n')).body))).body)

      expect(done).toContain('<dt>1</dt><dd>updated</dd>')
      expect(done).toContain('<dt>1</dt><dd>unchanged</dd>')
      expect((await userRow('imp-ann@example.com')).last_name).toBe('Smith')
    })

    it('only the person who checked the file can import it', async () => {
      const token = tokenOf((await upload(CSV)).body)

      const stranger = new Browser(h.app)
      expect((await apply(token, stranger)).statusCode).toBe(303)
      expect(await userRow('imp-ann@example.com')).toBeUndefined()
      expect((await apply('made-up-token')).statusCode).toBe(410)
    })
  })

  it('understands the example file of the repository, which has two rows to reject', async () => {
    const example = readFileSync(new URL('../../../../examples/users.csv', import.meta.url))

    const page = plain((await upload(example)).body)

    expect(page).toContain('Rows in the file: 6.')
    expect(page).toContain('<dt>3</dt><dd>would be created</dd>')
    expect(page).toContain('<dt>1</dt><dd>would be updated</dd>')
    expect(page).toMatch(/<dt><span[^>]*>2<\/span><\/dt><dd>rejected<\/dd>/)
    expect(page).toMatch(/<td>6<\/td><td>not-an-address<\/td>/)
  })

  describe('rows that cannot be imported', () => {
    const BAD = 'email,first_name,last_name,imp_team\r\nimp-ok@example.com,Okay,Person,MUC\r\nnot-an-address,Bad,Mail,MUC\r\nimp-team@example.com,Wrong,Team,munich\r\n'

    it('are listed with their line and the reason, and skipped when importing', async () => {
      const checked = plain((await upload(BAD)).body)

      expect(checked).toContain('Rejected rows')
      expect(checked).toMatch(/<td>3<\/td><td>not-an-address<\/td>/)
      expect(checked).toMatch(/<td>4<\/td><td>imp-team@example\.com<\/td>/)
      expect(checked).toMatch(/<dt><span[^>]*>2<\/span><\/dt><dd>rejected<\/dd>/)

      await apply(tokenOf(checked))
      expect(await userRow('imp-ok@example.com')).toBeDefined()
      expect(await userRow('imp-team@example.com')).toBeUndefined()
    })

    it('can be downloaded as a CSV in the layout of the file, with line and reason', async () => {
      const checked = (await upload(BAD)).body
      const href = /href="([^"]*rejected\?[^"]+)"/.exec(checked)?.[1]?.replaceAll('&amp;', '&')

      const download = await get(href!)

      expect(download.statusCode).toBe(200)
      expect(download.headers['content-type']).toBe('text/csv; charset=utf-8')
      expect(download.headers['content-disposition']).toBe('attachment; filename="rejected-rows.csv"')
      expect(download.headers['cache-control']).toBe('no-store')
      expect(download.body.startsWith('﻿email,first_name,last_name,imp_team,line,reason\r\n')).toBe(true)
      expect(download.body).toContain('not-an-address,Bad,Mail,MUC,3,')
    })

    it('can still be downloaded after the import', async () => {
      const checked = (await upload(BAD)).body
      const token = tokenOf(checked)!
      await apply(token)

      expect((await get(`/manage/import/rejected?token=${token}`)).statusCode).toBe(200)
    })

    it('are not offered for download when there are none, nor to somebody else', async () => {
      const clean = tokenOf((await upload(CSV)).body)!
      expect((await get(`/manage/import/rejected?token=${clean}`)).statusCode).toBe(404)

      const token = tokenOf((await upload(BAD)).body)!
      expect((await new Browser(h.app).request('GET', `/manage/import/rejected?token=${token}`)).statusCode).toBe(303)
      expect((await get('/manage/import/rejected?token=nonsense')).statusCode).toBe(404)
    })

    it('are shown without being able to inject markup', async () => {
      const page = plain((await upload('email,first_name,last_name\r\n<script>alert(1)</script>,A,B\r\n')).body)

      expect(page).not.toContain('<script>alert(1)')
      expect(page).toContain('&lt;script&gt;alert(1)')
    })
  })

  describe('a file that cannot be read', () => {
    it('is refused with the reason, and nothing is kept', async () => {
      const response = await upload('email,first_name,last_name,nonsense_column\r\nimp-x@example.com,X,Y,1\r\n')

      expect(response.statusCode).toBe(422)
      expect(plain(response.body)).toContain('The file cannot be imported:')
      expect(plain(response.body)).toContain('nonsense_column')
      expect(response.body).not.toContain('action="/manage/import/apply"')
    })

    it('can skip columns that are not claim types, with a warning', async () => {
      const response = await upload('email,first_name,last_name,nonsense_column\r\nimp-x@example.com,X,Y,1\r\n', { ignoreUnknown: 'on' })

      expect(response.statusCode).toBe(200)
      expect(plain(response.body)).toContain('Warnings')
      expect(plain(response.body)).toContain('nonsense_column')
    })

    it('says so when the file is not UTF-8, and reads Windows-1252 when asked to', async () => {
      const latin = Buffer.from('email,first_name,last_name\r\nimp-m@example.com,Jörg,Müller\r\n', 'latin1')

      const refused = await upload(latin)
      expect(refused.statusCode).toBe(422)
      expect(plain(refused.body)).toContain('not valid UTF-8')

      await apply(tokenOf((await upload(latin, { encoding: 'windows-1252' })).body))
      expect(await userRow('imp-m@example.com')).toMatchObject({ first_name: 'Jörg', last_name: 'Müller' })
    })

    it('reads a file written by German Excel: semicolons between columns', async () => {
      await apply(tokenOf((await upload('email;first_name;last_name;imp_region\r\nimp-s@example.com;Sam;Semi;a,b\r\n', { valueSeparator: ',' })).body))

      expect(await claimsOf('imp-s@example.com')).toEqual(['imp_region=a', 'imp_region=b'])
    })

    it('needs a file', async () => {
      const response = await browser.request('POST', '/manage/import', { multipart: { fields: { encoding: 'utf-8' } } })

      expect(response.statusCode).toBe(422)
      expect(response.body).toContain('Choose a CSV file.')
    })

    it('refuses a file larger than 5 MB', async () => {
      const big = Buffer.alloc(5 * 1024 * 1024 + 10, 'a')

      const response = await upload(big)

      expect(response.statusCode).toBe(413)
      expect(response.body).toContain('The file is larger than 5 MB.')
    })

    it('refuses a post that is not a file upload', async () => {
      const response = await browser.request('POST', '/manage/import', { form: { encoding: 'utf-8' } })

      expect(response.statusCode).toBe(415)
    })

    it('refuses an empty file', async () => {
      const response = await upload('   \r\n')

      expect(response.statusCode).toBe(422)
    })
  })

  describe('people who are not in the file', () => {
    const emails = async () => (await h.database.pool.query(`select email, status, is_admin from users order by email`)).rows as { email: string; status: string; is_admin: boolean }[]
    const everybodyExcept = async (gone: string) => {
      const rows = (await h.database.pool.query(`select email, first_name, last_name from users where not is_admin and email <> $1 and password_hash is not null`, [gone])).rows
      return `email,first_name,last_name\r\n${rows.map((r) => `${r.email},${r.first_name},${r.last_name}`).join('\r\n')}\r\n`
    }

    it('are left alone by default', async () => {
      const before = await emails()

      await apply(tokenOf((await upload(CSV)).body))

      expect((await emails()).filter((u) => !u.email.startsWith('imp-'))).toEqual(before)
    })

    it('are locked when asked to, which a check lists first; administrators are never touched', async () => {
      await h.database.pool.query(`insert into users (email, first_name, last_name, status, password_hash) values ('imp-gone@example.com', 'Gone', 'Person', 'active', 'x')`)
      const csv = await everybodyExcept('imp-gone@example.com')
      const settings = { missing: 'lock', maxMissingPercent: '100' }

      const checked = await upload(csv, settings)
      expect(plain(checked.body)).toContain('1 would be locked')
      expect(plain(checked.body)).toContain('imp-gone@example.com')
      expect((await userRow('imp-gone@example.com')).status).toBe('active')

      const done = await apply(tokenOf(checked.body))
      expect(plain(done.body)).toContain('1 locked')
      expect((await userRow('imp-gone@example.com')).status).toBe('locked')
      expect((await userRow('admin@example.com')).status).toBe('active')
    })

    it('refuse the whole import when too many would be affected, before anything is written', async () => {
      const csv = 'email,first_name,last_name\r\nimp-new@example.com,New,Person\r\n'

      const response = await upload(csv, { missing: 'lock', maxMissingPercent: '20' })

      expect(response.statusCode).toBe(422)
      expect(plain(response.body)).toContain('more than the allowed 20%')
      expect(await userRow('imp-new@example.com')).toBeUndefined()
    })

    it('are only deleted after typing the word, in the language of the page', async () => {
      await h.database.pool.query(`insert into users (email, first_name, last_name, status, password_hash) values ('imp-gone@example.com', 'Gone', 'Person', 'active', 'x')`)
      const csv = await everybodyExcept('imp-gone@example.com')
      const settings = { missing: 'delete', maxMissingPercent: '100' }

      const refused = await upload(csv, settings)
      expect(refused.statusCode).toBe(422)
      expect(refused.body).toContain('type DELETE in the box')
      expect((await upload(csv, { ...settings, confirmDelete: 'nope' })).statusCode).toBe(422)

      const checked = await upload(csv, { ...settings, confirmDelete: ' delete ' })
      expect(plain(checked.body)).toContain('1 would be deleted')
      expect(await userRow('imp-gone@example.com')).toBeDefined()

      const done = await apply(tokenOf(checked.body))
      expect(plain(done.body)).toContain('1 deleted')
      expect(await userRow('imp-gone@example.com')).toBeUndefined()
    })

    it('are deleted with the German word for an administrator who uses German', async () => {
      await h.database.pool.query(`update users set language = 'de' where email = 'admin@example.com'`)
      browser = await signedInToManage(h, Browser)
      const csv = 'email,first_name,last_name\r\nimp-new@example.com,New,Person\r\n'

      const refused = await upload(csv, { missing: 'delete', maxMissingPercent: '100', confirmDelete: 'DELETE' })

      expect(refused.statusCode).toBe(422)
      expect(refused.body).toContain('geben Sie LÖSCHEN in das Feld ein')
    })
  })

  describe('the form', () => {
    it('comes back with what was typed when it is refused', async () => {
      const response = await upload(CSV, { valueSeparator: '', maxMissingPercent: '150', ignoreUnknown: 'on', missing: 'lock', encoding: 'windows-1252' })

      expect(response.statusCode).toBe(422)
      expect(response.body).toContain('Check the entries marked below.')
      expect(response.body).toContain('value="150"')
      expect(response.body).toMatch(/<option value="lock" selected>/)
      expect(response.body).toMatch(/<option value="windows-1252" selected>/)
    })
  })

  it('shows the texts in German for an administrator who uses German', async () => {
    await h.database.pool.query(`update users set language = 'de' where email = 'admin@example.com'`)
    browser = await signedInToManage(h, Browser)

    expect((await get('/manage/import')).body).toContain('Benutzer importieren')
    const checked = plain((await upload(CSV)).body)
    expect(checked).toContain('Geprüft: es wurde nichts geschrieben')
    expect(checked).toContain('Jetzt importieren')
  })
})
