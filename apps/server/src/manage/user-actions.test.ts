import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { Browser } from '../test/browser.js'
import { signedInToManage } from '../test/manage-session.js'

describe.skipIf(!hasDatabase)('the administration: actions on a user', () => {
  let h: AdminHarness
  let browser: Browser
  let benId: string

  beforeAll(async () => {
    h = await createAdminHarness()
    h.notifier.smsAvailable = false
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(async () => {
    h.notifications.length = 0
    await h.database.pool.query('delete from rate_limits')
    await h.database.pool.query('delete from otp_codes')
    await h.database.pool.query(`delete from devices`)
    await h.database.pool.query(
      `update users set first_name = 'Ada', last_name = 'Admin', is_admin = true, status = 'active', language = 'en', last_login_at = null where email = 'admin@example.com'`,
    )
    await h.database.pool.query(
      `update users set status = 'active', is_admin = false, language = 'en', first_name = 'Ben', last_name = 'Keller', locked_at = null, password_hash = coalesce(password_hash, 'x') where email = 'ben.keller@example.com'`,
    )
    browser = await signedInToManage(h, Browser)
    benId = (await h.database.pool.query(`select id from users where email = 'ben.keller@example.com'`)).rows[0].id
  })

  const get = (url: string) => browser.request('GET', url)
  const post = (url: string, form: Record<string, string> = {}) => browser.request('POST', url, { form })
  const statusOfBen = async () => (await h.database.pool.query(`select status from users where id = $1`, [benId])).rows[0].status as string
  const follow = async (response: { statusCode: number; headers: Record<string, unknown> }) => {
    expect(response.statusCode).toBe(303)
    return get(response.headers.location as string)
  }
  const plain = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '')

  it('offers the actions that fit the status, and only those', async () => {
    const active = plain((await get(`/manage/users/${benId}`)).body)
    for (const name of ['lock', 'deactivate', 'reset-password', 'end-sessions', 'delete']) expect(active).toContain(`href="/manage/users/${benId}/${name}"`)
    expect(active).not.toContain(`/${benId}/unlock"`)

    await h.database.pool.query(`update users set status = 'locked' where id = $1`, [benId])
    const locked = plain((await get(`/manage/users/${benId}`)).body)
    expect(locked).toContain(`href="/manage/users/${benId}/unlock"`)
    expect(locked).not.toContain(`/${benId}/reset-password"`)
  })

  it('asks before it acts: a page names the person and the consequence, and changes nothing', async () => {
    const page = await get(`/manage/users/${benId}/lock`)

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Lock Ben Keller?')
    expect(page.body).toContain('signed out everywhere')
    expect(page.body).toContain(`action="/manage/users/${benId}/lock"`)
    expect(await statusOfBen()).toBe('active')
  })

  it('locks and unlocks, with a message after each', async () => {
    const locked = await follow(await post(`/manage/users/${benId}/lock`))
    expect(locked.body).toContain('Ben Keller was locked and signed out everywhere.')
    expect(await statusOfBen()).toBe('locked')

    const unlocked = await follow(await post(`/manage/users/${benId}/unlock`))
    expect(unlocked.body).toContain('Ben Keller was unlocked.')
    expect(await statusOfBen()).toBe('active')
  })

  it('records who did it: the person signed in to the administration', async () => {
    await post(`/manage/users/${benId}/lock`)

    const [event] = await h.audit('user.lock', benId)
    expect(event.actor_type).toBe('user')
    expect(event.actor_id).toBe((await h.database.pool.query(`select id from users where email = 'admin@example.com'`)).rows[0].id)
  })

  it('deactivates and activates again, sending no link to somebody who has a password', async () => {
    expect((await follow(await post(`/manage/users/${benId}/deactivate`))).body).toContain('Ben Keller was deactivated.')
    expect(await statusOfBen()).toBe('deactivated')

    expect((await get(`/manage/users/${benId}/reactivate`)).body).toContain('Activate Ben Keller again?')
    expect((await follow(await post(`/manage/users/${benId}/reactivate`))).body).toContain('Ben Keller can sign in again.')
    expect(await statusOfBen()).toBe('active')
  })

  it('sends an activation link to somebody who has not chosen a password', async () => {
    await h.database.pool.query(`update users set status = 'created', password_hash = null where id = $1`, [benId])

    const page = await follow(await post(`/manage/users/${benId}/activate`))

    expect(page.body).toContain('The activation link was sent to ben.keller@example.com.')
    expect(h.notifications.length).toBeGreaterThan(0)
  })

  it('resets a password and signs the person out everywhere', async () => {
    await h.database.pool.query(`insert into oidc_payloads (id, type, payload, account_id) values ('ua-1', 1, '{}', $1)`, [benId])

    const page = await follow(await post(`/manage/users/${benId}/reset-password`))

    expect(page.body).toContain('A code to choose a new password was sent to Ben Keller.')
    expect((await h.database.pool.query(`select count(*)::int as n from oidc_payloads where account_id = $1`, [benId])).rows[0].n).toBe(0)
  })

  it('signs out everywhere and says how much ended', async () => {
    await h.database.pool.query(`insert into oidc_payloads (id, type, payload, account_id) values ('ua-2', 1, '{}', $1), ('ua-3', 1, '{}', $1)`, [benId])

    const page = await follow(await post(`/manage/users/${benId}/end-sessions`))

    expect(page.body).toContain('Ben Keller was signed out everywhere (2 sessions and applications, 0 remembered devices ended).')
    expect(await statusOfBen()).toBe('active')
  })

  it('says why an action is not possible instead of trying it', async () => {
    await h.database.pool.query(`update users set status = 'deactivated' where id = $1`, [benId])

    const page = await get(`/manage/users/${benId}/lock`)

    expect(page.body).toContain('This cannot be done for Ben Keller now, as the user is Deactivated.')
    expect(page.body).not.toContain(`<form class="fields" method="post"`)
    const attempt = await post(`/manage/users/${benId}/lock`)
    expect(attempt.statusCode).toBe(409)
    expect(await statusOfBen()).toBe('deactivated')
  })

  it('does not let the last administrator be locked, deactivated or deleted, and shows the reason', async () => {
    const adminId = (await h.database.pool.query(`select id from users where email = 'admin@example.com'`)).rows[0].id as string
    await h.database.pool.query(`update users set is_admin = false where id <> $1`, [adminId])

    const page = await post(`/manage/users/${adminId}/deactivate`)

    expect(page.statusCode).toBe(409)
    expect(page.body).toMatch(/role="alert">[^<]*administrator/i)
    expect((await h.database.pool.query(`select status from users where id = $1`, [adminId])).rows[0].status).toBe('active')
  })

  describe('deleting', () => {
    it('asks for the e-mail address and refuses another one', async () => {
      const page = await post(`/manage/users/${benId}/delete`, { confirmEmail: 'somebody.else@example.com' })

      expect(page.statusCode).toBe(422)
      expect(page.body).toContain('The address you typed is not the address of this user.')
      expect((await h.database.pool.query(`select 1 from users where id = $1`, [benId])).rowCount).toBe(1)
    })

    it('deletes when the address matches, whatever the case, and goes back to the list', async () => {
      const confirm = await get(`/manage/users/${benId}/delete`)
      expect(confirm.body).toContain('type the e-mail address ben.keller@example.com')

      const response = await post(`/manage/users/${benId}/delete`, { confirmEmail: ' Ben.Keller@Example.com ' })
      expect(response.headers.location).toBe('/manage/users')
      expect((await follow(response)).body).toContain('Ben Keller was deleted.')
      expect((await h.database.pool.query(`select 1 from users where id = $1`, [benId])).rowCount).toBe(0)

      // put the seeded user back for the other tests
      await h.database.pool.query(`insert into users (id, email, first_name, last_name, status, password_hash) values ($1, 'ben.keller@example.com', 'Ben', 'Keller', 'active', 'x')`, [benId])
    })
  })

  it('answers 404 for an unknown action or user', async () => {
    expect((await get(`/manage/users/${benId}/explode`)).statusCode).toBe(404)
    expect((await get('/manage/users/00000000-0000-4000-8000-000000000000/lock')).statusCode).toBe(404)
    expect((await post(`/manage/users/${benId}/explode`)).statusCode).toBe(404)
  })

  it('needs a signed-in administrator', async () => {
    const response = await new Browser(h.app).request('POST', `/manage/users/${benId}/lock`, { form: {} })
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/manage/login')
    expect(await statusOfBen()).toBe('active')
  })

  describe('remembered devices', () => {
    const addDevice = async (agent: string | null = 'Firefox on Linux') =>
      (
        await h.database.pool.query(
          `insert into devices (user_id, token_hash, user_agent, expires_at) values ($1, md5(random()::text), $2, now() + interval '30 days') returning id`,
          [benId, agent],
        )
      ).rows[0].id as string

    it('lists them and revokes one', async () => {
      const first = await addDevice()
      await addDevice('Safari on iPhone')

      const page = plain((await get(`/manage/users/${benId}`)).body)
      expect(page).toContain('Remembered devices')
      expect(page).toContain('Firefox on Linux')
      expect(page).toContain('Safari on iPhone')

      const after = await follow(await post(`/manage/users/${benId}/devices/${first}/revoke`))
      expect(after.body).toContain('The device was revoked.')
      expect(plain(after.body)).not.toContain('Firefox on Linux')
      expect(plain(after.body)).toContain('Safari on iPhone')
    })

    it('revokes all', async () => {
      await addDevice()
      await addDevice()

      const after = await follow(await post(`/manage/users/${benId}/devices-revoke-all`))

      expect(after.body).toContain('2 remembered devices were revoked.')
      expect(plain(after.body)).toContain('No device is remembered.')
    })

    it('shows an unknown browser as such and escapes what a browser sends', async () => {
      await addDevice('<script>alert(1)</script>')
      await addDevice(null)

      const page = plain((await get(`/manage/users/${benId}`)).body)

      expect(page).not.toContain('<script>alert(1)')
      expect(page).toContain('&lt;script&gt;alert(1)')
      expect(page).toContain('Unknown browser')
    })

    it('answers 404 for a device that is not there', async () => {
      expect((await post(`/manage/users/${benId}/devices/00000000-0000-4000-8000-000000000000/revoke`)).statusCode).toBe(404)
    })
  })

  describe('signed in and recent sign-ins', () => {
    it('says so when there is nothing', async () => {
      const page = plain((await get(`/manage/users/${benId}`)).body)

      expect(page).toContain('Not signed in anywhere.')
      expect(page).toContain('No sign-in has been recorded.')
    })

    it('shows the browsers and applications where somebody is signed in', async () => {
      await h.database.pool.query(
        `insert into oidc_payloads (id, type, payload, account_id, expires_at) values ('sess-x', 1, $1, $2, now() + interval '1 day')`,
        [JSON.stringify({ accountId: benId, loginTs: Math.floor(Date.now() / 1000), authorizations: { 'demo-web': {} }, acr: 'urn:pforte:acr:mfa' }), benId],
      )

      const page = plain((await get(`/manage/users/${benId}`)).body)

      expect(page).not.toContain('Not signed in anywhere.')
      expect(page).toContain('With a code')
    })

    it('lists recent sign-ins in words', async () => {
      const origin = { ip: '203.0.113.9', userAgent: 'vitest' }
      await h.loginAudit.passwordFailed(origin, { userId: benId, email: 'ben.keller@example.com', reason: 'wrong_password' })
      await h.loginAudit.succeeded(origin, { userId: benId, method: 'code', channel: 'email', acr: 'urn:pforte:acr:mfa' })

      const page = plain((await get(`/manage/users/${benId}`)).body)

      expect(page).toContain('Wrong password')
      expect(page).toContain('Signed in with a code by e-mail')
      expect(page).toContain('203.0.113.9')
    })

    it('shows the texts in German for an administrator who uses German', async () => {
      await h.database.pool.query(`update users set language = 'de' where email = 'admin@example.com'`)
      browser = await signedInToManage(h, Browser)

      const page = plain((await get(`/manage/users/${benId}`)).body)
      expect(page).toContain('Gemerkte Geräte')
      expect((await get(`/manage/users/${benId}/lock`)).body).toContain('Ben Keller sperren?')
    })
  })
})
