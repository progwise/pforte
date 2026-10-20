import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { Browser } from '../test/browser.js'
import { signedInToManage } from '../test/manage-session.js'

describe.skipIf(!hasDatabase)('the administration: users', () => {
  let h: AdminHarness
  let browser: Browser
  let adminId: string

  beforeAll(async () => {
    h = await createAdminHarness()
    await h.database.pool.query(`insert into claim_types (key, description, value_pattern, multi_valued) values ('team_code', 'The team', '^[A-Z]{3}$', false) on conflict do nothing`)
    h.notifier.smsAvailable = false
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(async () => {
    h.notifications.length = 0
    await h.database.pool.query('delete from rate_limits')
    await h.database.pool.query('delete from otp_codes')
    await h.database.pool.query(`delete from users where email like 'zz%@example.com' or email like 'new.%@example.com'`)
    await h.database.pool.query(
      `update users set first_name = 'Ada', last_name = 'Admin', is_admin = true, status = 'active', language = 'en', last_login_at = null where email = 'admin@example.com'`,
    )
    await h.database.pool.query(`update users set status = 'active', is_admin = false, language = 'en', phone = '+4915100000002', phone_verified_at = null, first_name = 'Ben', last_name = 'Keller', email = 'ben.keller@example.com' where email = 'ben.keller@example.com' or first_name = 'Benedikt'`)
    await h.database.pool.query(`update users set status = 'active', is_admin = false, language = 'en', phone = '+4915100000001', phone_verified_at = null, email_verified_at = null where email = 'anna.schmidt@example.com'`)
    await h.database.pool.query(`delete from user_claims where claim_type_key = 'team_code'`)
    browser = await signedInToManage(h, Browser)
    adminId = (await h.database.pool.query(`select id from users where email = 'admin@example.com'`)).rows[0].id
  })

  const get = (url: string, headers: Record<string, string> = {}) => browser.request('GET', url, { headers })
  const post = (url: string, form: Record<string, string>, headers: Record<string, string> = {}) => browser.request('POST', url, { form, headers })
  const userId = async (email: string) => (await h.database.pool.query(`select id from users where email = $1`, [email])).rows[0].id as string
  /** Follows the redirect after an action and returns the page with its message. */
  const follow = async (response: { statusCode: number; headers: Record<string, unknown> }) => {
    expect(response.statusCode).toBe(303)
    return get(response.headers.location as string)
  }
  const plain = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '')

  it('is closed to somebody who is not signed in', async () => {
    const response = await new Browser(h.app).request('GET', '/manage/users')
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/manage/login?next=%2Fmanage%2Fusers')
  })

  describe('the list', () => {
    it('shows people with their status and when they last signed in, and marks administrators', async () => {
      await h.database.pool.query(`update users set last_login_at = '2030-06-01T10:30:00Z' where email = 'ben.keller@example.com'`)
      const page = await get('/manage/users')

      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('<h1>Users</h1>')
      expect(page.body).toContain('Ben Keller')
      expect(page.body).toContain('ben.keller@example.com')
      expect(page.body).toMatch(/Ada Admin<\/a> <span class="badge admin">Administrator<\/span>/)
      expect(page.body).toContain('<span class="badge active">Active</span>')
      // shown in the time zone of the installation (Europe/Berlin), not in UTC
      expect(page.body).toContain('12:30')
      expect(page.body).toContain('>Never<')
      expect(page.body).toContain('aria-current="page">Users</a>')
    })

    it('finds people by name or e-mail, and keeps what was typed', async () => {
      const page = await get('/manage/users?search=keller')
      expect(page.body).toContain('Ben Keller')
      expect(page.body).not.toContain('anna.schmidt@example.com')
      expect(page.body).toContain('name="search" type="search" value="keller"')
      expect(plain((await get('/manage/users?search=anna.schmidt@')).body)).toContain('Anna Schmidt')
    })

    it('filters by status', async () => {
      await h.database.pool.query(`update users set status = 'locked' where email = 'ben.keller@example.com'`)
      const page = await get('/manage/users?status=locked')
      expect(page.body).toContain('Ben Keller')
      expect(page.body).not.toContain('Anna Schmidt')
      expect(page.body).toMatch(/<option value="locked" selected>Locked<\/option>/)
    })

    it('filters by the value of a claim', async () => {
      const anna = await userId('anna.schmidt@example.com')
      await h.database.pool.query(`insert into user_claims (user_id, claim_type_key, value) values ($1, 'team_code', 'MUC')`, [anna])
      const page = await get('/manage/users?claimType=team_code&claimValue=MUC')
      expect(page.body).toContain('Anna Schmidt')
      expect(page.body).not.toContain('Ben Keller')
      expect(page.body).toMatch(/<option value="team_code" selected>team_code<\/option>/)
      expect(page.body).toContain('value="MUC"')
    })

    it('says so when nobody matches, and offers to show everyone again', async () => {
      const page = await get('/manage/users?search=nobody-has-this-name')
      expect(page.body).toContain('No user matches.')
      expect(page.body).toContain('href="/manage/users"')
      expect(page.body).toContain('Show all')
    })

    it('keeps a search to 200 characters, in the form and in what is asked, so a huge pattern is never sent to the database', async () => {
      const page = await get(`/manage/users?search=${'a'.repeat(5000)}&claimType=team_code&claimValue=${'b'.repeat(5000)}`)
      expect(page.statusCode).toBe(200)
      expect(page.body).toContain(`value="${'a'.repeat(200)}"`)
      expect(page.body).not.toContain('a'.repeat(201))
      expect(page.body).not.toContain('b'.repeat(201))
      expect(page.body).toContain('maxlength="200"')
    })

    it('ignores a status it does not know instead of failing', async () => {
      expect((await get('/manage/users?status=banana')).statusCode).toBe(200)
    })

    it('pages through many people without repeating anyone, and keeps the filters in the link', async () => {
      for (let n = 0; n < 30; n++) {
        await h.database.pool.query(`insert into users (email, first_name, last_name) values ($1, 'Zed', $2)`, [`zz${String(n).padStart(2, '0')}@example.com`, `Person${n}`])
      }
      const first = await get('/manage/users?search=zed')
      const next = /href="([^"]+)"[^>]*>Next users</.exec(first.body)?.[1]?.replaceAll('&amp;', '&')
      expect(next).toBeDefined()
      expect(next).toContain('search=zed')
      expect(next).toContain('cursor=')

      const second = await get(next!)
      const names = (html: string) => [...html.matchAll(/>Zed (Person\d+)</g)].map((match) => match[1]!)
      expect(names(first.body)).toHaveLength(25)
      expect(names(second.body)).toHaveLength(5)
      expect(new Set([...names(first.body), ...names(second.body)]).size).toBe(30)
      expect(/Next users/.test(second.body)).toBe(false)
    })

    it('shows names as text and never as markup', async () => {
      await h.database.pool.query(`insert into users (email, first_name, last_name) values ('zzx@example.com', '<script>alert(1)</script>', '"><img src=x>')`)
      const page = await get('/manage/users?search=zzx')
      expect(page.body).not.toContain('<script>alert(1)</script>')
      expect(page.body).not.toContain('<img src=x>')
      expect(page.body).toContain('&lt;script&gt;')
    })

    it('speaks German to a German administrator', async () => {
      // the language is that of the administrator when they sign in
      await h.database.pool.query(`update users set language = 'de' where email = 'admin@example.com'`)
      browser = await signedInToManage(h, Browser)
      const page = await get('/manage/users')
      expect(page.body).toContain('<h1>Benutzer</h1>')
      expect(page.body).toContain('Letzte Anmeldung')
      expect(page.body).toContain('Neuer Benutzer')
      expect(page.body).toContain('>Nie<')
    })
  })

  describe('one person', () => {
    it('shows the facts, the profile in a form, and the claims', async () => {
      const anna = await userId('anna.schmidt@example.com')
      await h.database.pool.query(`insert into user_claims (user_id, claim_type_key, value) values ($1, 'team_code', 'MUC')`, [anna])
      await h.database.pool.query(`update users set phone = '+4915112345678', phone_verified_at = now(), email_verified_at = now() where id = $1`, [anna])
      const page = await get(`/manage/users/${anna}`)

      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('<h1>Anna Schmidt</h1>')
      expect(page.body).toContain('<span class="badge active">Active</span>')
      expect(page.body).toContain(`action="/manage/users/${anna}"`)
      expect(page.body).toContain('name="firstName" type="text" value="Anna"')
      expect(page.body).toContain('value="+4915112345678"')
      expect(page.body).toMatch(/<option value="en" selected>en<\/option>/)
      expect(page.body).toContain(`action="/manage/users/${anna}/claims"`)
      expect(page.body).toContain('name="claim_team_code" type="text" value="MUC"')
      expect(page.body).toContain('Format: ^[A-Z]{3}$')
      expect(page.body).toContain('href="/manage/users"')
    })

    it('answers not found for somebody who does not exist, or an address that is not an id', async () => {
      for (const id of ['018f0000-0000-7000-8000-000000000000', 'not-an-id', '12345']) {
        const page = await get(`/manage/users/${id}`)
        expect(page.statusCode, id).toBe(404)
        expect(page.body).toContain('Not found')
        expect(page.body).toContain('href="/manage/users"')
      }
    })
  })

  describe('changing the profile', () => {
    it('saves, goes back to the person with a message, and records the administrator by name', async () => {
      const ben = await userId('ben.keller@example.com')
      const response = await post(`/manage/users/${ben}`, { firstName: 'Benedikt', lastName: 'Keller', email: 'ben.keller@example.com', phone: '+4915198765432', language: 'de' })
      expect(response.headers.location).toBe(`/manage/users/${ben}`)

      const page = await follow(response)
      expect(page.body).toContain('Benedikt Keller was saved.')
      expect(page.body).toContain('role="status"')
      expect(page.body).toContain('value="+4915198765432"')
      expect(page.body).toMatch(/<option value="de" selected>de<\/option>/)

      const [event] = await h.audit('user.update', ben)
      expect(event).toMatchObject({ actor_type: 'user', actor_id: adminId })
      // the message is shown once
      expect((await get(`/manage/users/${ben}`)).body).not.toContain('was saved.')
    })

    it('says so when nothing changed', async () => {
      const ben = await userId('ben.keller@example.com')
      const phone = (await h.database.pool.query(`select phone from users where id = $1`, [ben])).rows[0].phone ?? ''
      const page = await follow(await post(`/manage/users/${ben}`, { firstName: 'Ben', lastName: 'Keller', email: 'ben.keller@example.com', phone, language: 'en' }))
      expect(page.body).toContain('Nothing was changed.')
    })

    it('clears the phone when the field is emptied', async () => {
      const ben = await userId('ben.keller@example.com')
      await h.database.pool.query(`update users set phone = '+4915112345678' where id = $1`, [ben])
      await post(`/manage/users/${ben}`, { firstName: 'Ben', lastName: 'Keller', email: 'ben.keller@example.com', phone: '', language: 'en' })
      expect((await h.database.pool.query(`select phone from users where id = $1`, [ben])).rows[0].phone).toBeNull()
    })

    it('makes somebody an administrator, and takes it away again', async () => {
      const ben = await userId('ben.keller@example.com')
      const base = { firstName: 'Ben', lastName: 'Keller', email: 'ben.keller@example.com', phone: '', language: 'en' }
      await post(`/manage/users/${ben}`, { ...base, isAdmin: 'on' })
      expect((await h.database.pool.query(`select is_admin from users where id = $1`, [ben])).rows[0].is_admin).toBe(true)
      await post(`/manage/users/${ben}`, base)
      expect((await h.database.pool.query(`select is_admin from users where id = $1`, [ben])).rows[0].is_admin).toBe(false)
    })

    it('comes back with what was typed and what is wrong with it, when the entries are not valid', async () => {
      const ben = await userId('ben.keller@example.com')
      const response = await post(`/manage/users/${ben}`, { firstName: 'Ben', lastName: 'Keller', email: 'not-an-address', phone: '0151 123', language: 'en' })

      expect(response.statusCode).toBe(422)
      expect(response.body).toContain('Please check the entries marked below.')
      expect(response.body).toContain('role="alert"')
      expect(response.body).toContain('value="not-an-address"')
      expect(response.body).toContain('value="0151 123"')
      expect(response.body).toMatch(/class="field-error">[^<]*E\.164/)
      expect(response.body).toContain('aria-invalid="true"')
      // nothing was written
      expect((await h.database.pool.query(`select email from users where id = $1`, [ben])).rows[0].email).toBe('ben.keller@example.com')
    })

    it('says why when an e-mail address is taken', async () => {
      const ben = await userId('ben.keller@example.com')
      const response = await post(`/manage/users/${ben}`, { firstName: 'Ben', lastName: 'Keller', email: 'anna.schmidt@example.com', phone: '', language: 'en' })
      expect(response.statusCode).toBe(409)
      expect(response.body).toContain('The change was not made:')
      expect(response.body).toContain('value="anna.schmidt@example.com"')
    })

    it('does not let an administrator take the right from themselves, and says so', async () => {
      const response = await post(`/manage/users/${adminId}`, { firstName: 'Ada', lastName: 'Admin', email: 'admin@example.com', phone: '', language: 'en' })
      expect(response.statusCode).toBe(409)
      expect(response.body).toContain('yourself')
      expect((await h.database.pool.query(`select is_admin from users where id = $1`, [adminId])).rows[0].is_admin).toBe(true)
    })
  })

  describe('claims', () => {
    it('saves one value per line, and removes what is emptied', async () => {
      const anna = await userId('anna.schmidt@example.com')
      const saved = await follow(await post(`/manage/users/${anna}/claims`, { claim_team_code: ' MUC \n' }))
      expect(saved.body).toContain('The claims of Anna Schmidt were saved.')
      const values = async () => (await h.database.pool.query(`select value from user_claims where user_id = $1 and claim_type_key = 'team_code'`, [anna])).rows.map((row) => row.value)
      expect(await values()).toEqual(['MUC'])

      await post(`/manage/users/${anna}/claims`, { claim_team_code: '' })
      expect(await values()).toEqual([])
    })

    it('says so when nothing changed', async () => {
      const anna = await userId('anna.schmidt@example.com')
      await post(`/manage/users/${anna}/claims`, { claim_team_code: 'MUC' })
      expect((await follow(await post(`/manage/users/${anna}/claims`, { claim_team_code: 'MUC' }))).body).toContain('Nothing was changed.')
    })

    it('keeps what was typed and says what is wrong when a value does not fit its format', async () => {
      const anna = await userId('anna.schmidt@example.com')
      const response = await post(`/manage/users/${anna}/claims`, { claim_team_code: 'munich' })
      expect(response.statusCode).toBe(422)
      expect(response.body).toContain('value="munich"')
      expect(response.body).toMatch(/class="flash error" role="alert">[^<]*team_code/)
      expect((await h.database.pool.query(`select count(*) from user_claims where user_id = $1 and claim_type_key = 'team_code'`, [anna])).rows[0].count).toBe('0')
    })

    it('leaves the claims of other types alone', async () => {
      const anna = await userId('anna.schmidt@example.com')
      const before = (await h.database.pool.query(`select count(*) from user_claims where user_id = $1 and claim_type_key <> 'team_code'`, [anna])).rows[0].count
      await post(`/manage/users/${anna}/claims`, { claim_team_code: 'MUC' })
      expect((await h.database.pool.query(`select count(*) from user_claims where user_id = $1 and claim_type_key <> 'team_code'`, [anna])).rows[0].count).toBe(before)
    })
  })

  describe('a new person', () => {
    it('shows a form with the language of the installation', async () => {
      const page = await get('/manage/users/new')
      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('<h1>New user</h1>')
      expect(page.body).toContain('action="/manage/users"')
      expect(page.body).toMatch(/<option value="en" selected>en<\/option>/)
      expect(page.body).toContain('Create user')
    })

    it('creates them, goes to their page with a message, and records the administrator by name', async () => {
      const response = await post('/manage/users', { firstName: 'Neo', lastName: 'Person', email: ' New.Person@Example.com ', phone: '+4915112345678', language: 'de' })
      expect(response.statusCode).toBe(303)
      const page = await follow(response)
      expect(page.body).toContain('Neo Person was created.')

      const { rows } = await h.database.pool.query(`select id, email, status, language, is_admin, phone from users where email = 'new.person@example.com'`)
      expect(rows[0]).toMatchObject({ status: 'created', language: 'de', is_admin: false, phone: '+4915112345678' })
      expect(response.headers.location).toBe(`/manage/users/${rows[0].id}`)
      expect((await h.audit('user.create', rows[0].id))[0]).toMatchObject({ actor_type: 'user', actor_id: adminId })
    })

    it('can make an administrator', async () => {
      await post('/manage/users', { firstName: 'Neo', lastName: 'Boss', email: 'new.boss@example.com', language: 'en', isAdmin: 'on' })
      expect((await h.database.pool.query(`select is_admin from users where email = 'new.boss@example.com'`)).rows[0].is_admin).toBe(true)
    })

    it('comes back with what was typed and what is wrong, when the entries are not valid', async () => {
      const response = await post('/manage/users', { firstName: 'Neo', lastName: '', email: 'broken', phone: '', language: 'en' })
      expect(response.statusCode).toBe(422)
      expect(response.body).toContain('value="Neo"')
      expect(response.body).toContain('value="broken"')
      expect(response.body).toContain('Please check the entries marked below.')
      expect(response.body).toContain('class="field-error"')
      expect((await h.database.pool.query(`select count(*) from users where email = 'broken'`)).rows[0].count).toBe('0')
    })

    it('says when the e-mail address already belongs to somebody', async () => {
      const response = await post('/manage/users', { firstName: 'Ben', lastName: 'Again', email: 'ben.keller@example.com', language: 'en' })
      expect(response.statusCode).toBe(409)
      expect(response.body).toContain('The change was not made:')
      expect(response.body).toContain('value="ben.keller@example.com"')
    })
  })

  describe('safety', () => {
    it('refuses a post from another site, for the profile, the claims and a new person', async () => {
      const ben = await userId('ben.keller@example.com')
      for (const [url, form] of [
        [`/manage/users/${ben}`, { firstName: 'Hacked', lastName: 'Keller', email: 'ben.keller@example.com', language: 'en' }],
        [`/manage/users/${ben}/claims`, { claim_team_code: 'EVL' }],
        ['/manage/users', { firstName: 'Evil', lastName: 'Person', email: 'new.evil@example.com' }],
      ] as const) {
        const response = await post(url, { ...form }, { 'sec-fetch-site': 'cross-site' })
        expect(response.statusCode, url).toBe(403)
      }
      expect((await h.database.pool.query(`select first_name from users where id = $1`, [ben])).rows[0].first_name).toBe('Ben')
      expect((await h.database.pool.query(`select count(*) from users where email = 'new.evil@example.com'`)).rows[0].count).toBe('0')
    })

    it('sends the person to sign in again when the API no longer accepts their token, such as after losing the admin right', async () => {
      await h.database.pool.query(`update users set is_admin = false where email = 'admin@example.com'`)
      const page = await get('/manage/users')
      expect(page.statusCode).toBe(303)
      expect(page.headers.location).toBe('/manage/login')
      expect(String(page.headers['set-cookie'])).toMatch(/pforte_manage=;/)
      await h.database.pool.query(`update users set is_admin = true where email = 'admin@example.com'`)
    })
  })
})
