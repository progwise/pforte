import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { Browser } from '../test/browser.js'
import { signedInToManage } from '../test/manage-session.js'

describe.skipIf(!hasDatabase)('the administration: claim types', () => {
  let h: AdminHarness
  let browser: Browser

  beforeAll(async () => {
    h = await createAdminHarness()
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(async () => {
    await h.database.pool.query('delete from rate_limits')
    await h.database.pool.query('delete from otp_codes')
    await h.database.pool.query(`delete from user_claims where claim_type_key like 'zz_%'`)
    await h.database.pool.query(`delete from claim_types where key like 'zz_%'`)
    await h.database.pool.query(
      `update users set first_name = 'Ada', last_name = 'Admin', is_admin = true, status = 'active', language = 'en' where email = 'admin@example.com'`,
    )
    browser = await signedInToManage(h, Browser)
  })

  const get = (url: string) => browser.request('GET', url)
  const post = (url: string, form: Record<string, string | string[]> = {}) => browser.request('POST', url, { form })
  const plain = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '')
  const follow = async (response: { statusCode: number; headers: Record<string, unknown> }) => {
    expect(response.statusCode).toBe(303)
    return get(response.headers.location as string)
  }
  const row = async (key: string) => (await h.database.pool.query(`select * from claim_types where key = $1`, [key])).rows[0]
  const create = (extra: Record<string, string> = {}) => post('/manage/claim-types', { key: 'zz_team', description: 'The team', valuePattern: '^[A-Z]{3}$', ...extra })

  it('is closed to somebody who is not signed in', async () => {
    const response = await new Browser(h.app).request('GET', '/manage/claim-types')
    expect(response.statusCode).toBe(303)
  })

  it('lists the claim types with format, values and the clients that receive them', async () => {
    await create({ multiValued: 'on' })
    await h.database.pool.query(`insert into client_claim_types (client_id, claim_type_key) values ('demo-web', 'zz_team')`)

    const page = plain((await get('/manage/claim-types')).body)

    expect(page).toContain('<h1>Claim types</h1>')
    expect(page).toMatch(/zz_team<\/a><\/td>\s*<td>The team<\/td>\s*<td><code>\^\[A-Z\]\{3\}\$<\/code><\/td>\s*<td>Several<\/td>\s*<td><a href="\/manage\/clients\/demo-web">demo-web<\/a>/)
    expect(page).toContain('aria-current="page">Claim types</a>')
  })

  describe('creating', () => {
    it('creates a claim type and says so', async () => {
      const page = await follow(await create())

      expect(page.body).toContain('The claim type zz_team was created.')
      expect(await row('zz_team')).toMatchObject({ description: 'The team', value_pattern: '^[A-Z]{3}$', multi_valued: false })
    })

    it('is available to users at once: their page offers a field for it', async () => {
      await create()
      const ben = (await h.database.pool.query(`select id from users where email = 'ben.keller@example.com'`)).rows[0].id

      expect((await get(`/manage/users/${ben}`)).body).toContain('name="claim_zz_team"')
    })

    it('comes back with what was typed when the entry is wrong', async () => {
      const response = await create({ key: 'Bad Key!', valuePattern: '([' })

      expect(response.statusCode).toBe(422)
      expect(response.body).toContain('Please check the entries marked below.')
      expect(response.body).toContain('value="Bad Key!"')
      expect(response.body).toContain('Not a valid regular expression')
    })

    it('refuses a name that tokens already use', async () => {
      const response = await create({ key: 'email' })

      expect(response.statusCode).toBeGreaterThanOrEqual(400)
      expect(await row('email')).toBeUndefined()
    })

    it('says so when the key exists', async () => {
      await create()

      const again = await create()

      expect(again.statusCode).toBe(409)
      expect(again.body).toContain('already exists')
    })
  })

  describe('one claim type', () => {
    beforeEach(async () => {
      await create()
    })

    it('shows it, and changes it', async () => {
      expect((await get('/manage/claim-types/zz_team')).body).toContain('<h1>zz_team</h1>')

      const saved = await follow(await post('/manage/claim-types/zz_team', { description: 'Team abbreviation', valuePattern: '', multiValued: 'on' }))

      expect(saved.body).toContain('The claim type zz_team was saved.')
      expect(await row('zz_team')).toMatchObject({ description: 'Team abbreviation', value_pattern: null, multi_valued: true })
    })

    it('says when there was nothing to change', async () => {
      const same = await follow(await post('/manage/claim-types/zz_team', { description: 'The team', valuePattern: '^[A-Z]{3}$' }))

      expect(same.body).toContain('Nothing was changed.')
    })

    it('refuses a format that existing values do not match, and keeps what was typed', async () => {
      const ben = (await h.database.pool.query(`select id from users where email = 'ben.keller@example.com'`)).rows[0].id
      await h.database.pool.query(`insert into user_claims (user_id, claim_type_key, value) values ($1, 'zz_team', 'MUC')`, [ben])

      const response = await post('/manage/claim-types/zz_team', { description: 'The team', valuePattern: '^[0-9]+$' })

      expect(response.statusCode).toBe(409)
      expect(response.body).toContain('value="^[0-9]+$"')
      expect((await row('zz_team')).value_pattern).toBe('^[A-Z]{3}$')
    })

    it('answers 404 for an unknown key', async () => {
      expect((await get('/manage/claim-types/zz_nothing')).statusCode).toBe(404)
      expect((await post('/manage/claim-types/zz_nothing', {})).statusCode).toBe(404)
    })
  })

  describe('deleting', () => {
    beforeEach(async () => {
      await create()
    })

    it('asks first and deletes a type nobody holds', async () => {
      const confirm = await get('/manage/claim-types/zz_team/delete')
      expect(confirm.body).toContain('Delete the claim type zz_team?')
      expect(await row('zz_team')).toBeDefined()

      const response = await post('/manage/claim-types/zz_team/delete')

      expect(response.headers.location).toBe('/manage/claim-types')
      expect((await follow(response)).body).toContain('The claim type zz_team was deleted.')
      expect(await row('zz_team')).toBeUndefined()
    })

    it('is refused while people hold values, unless the values go too', async () => {
      const ben = (await h.database.pool.query(`select id from users where email = 'ben.keller@example.com'`)).rows[0].id
      await h.database.pool.query(`insert into user_claims (user_id, claim_type_key, value) values ($1, 'zz_team', 'MUC')`, [ben])

      const refused = await post('/manage/claim-types/zz_team/delete')
      expect(refused.statusCode).toBe(409)
      expect(refused.body).toContain('role="alert"')
      expect(await row('zz_team')).toBeDefined()

      const forced = await post('/manage/claim-types/zz_team/delete', { force: 'on' })
      expect(forced.statusCode).toBe(303)
      expect(await row('zz_team')).toBeUndefined()
      expect((await h.database.pool.query(`select 1 from user_claims where claim_type_key = 'zz_team'`)).rowCount).toBe(0)
    })
  })

  it('shows the texts in German for an administrator who uses German', async () => {
    await h.database.pool.query(`update users set language = 'de' where email = 'admin@example.com'`)
    browser = await signedInToManage(h, Browser)

    expect((await get('/manage/claim-types')).body).toContain('Neuer Claim-Typ')
  })
})
