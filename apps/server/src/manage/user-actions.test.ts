import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type AdminHarness, createAdminHarness } from '../test/admin-harness.js'
import { Browser } from '../test/browser.js'
import { signedInToManage } from '../test/manage-session.js'
import { NotifierUnavailableError } from '../notifications/notifier.js'

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

  it('invites an administrator to the administration, which the page after choosing the password leads on to', async () => {
    const invite = async () => {
      h.notifications.length = 0
      await h.database.pool.query(`update users set status = 'created', password_hash = null where id = $1`, [benId])
      await follow(await post(`/manage/users/${benId}/activate`))
      const { url, applicationName } = h.notifications.findLast((n) => n.kind === 'activation')!
      const chosen = await new Browser(h.app).request('POST', '/activate', {
        form: { token: new URL(url!).searchParams.get('token')!, password: 'a long enough passphrase', confirm: 'a long enough passphrase' },
      })
      expect(chosen.statusCode, chosen.body).toBe(200)
      expect(chosen.body).toContain('Your account is active')
      return { page: chosen.body, applicationName }
    }

    // somebody who is no administrator, and no application chosen for them: nothing says where they are going
    const person = await invite()
    expect(person.applicationName).toBeUndefined()
    expect(person.page).not.toContain('Continue to')

    await h.database.pool.query(`update users set is_admin = true where id = $1`, [benId])
    const administrator = await invite()
    expect(administrator.applicationName).toBe('Administration')
    expect(administrator.page).toContain('<a class="button" href="https://localhost:3300/manage">Continue to Administration</a>')
    expect((await h.database.pool.query(`select details from audit_events where action = 'user.activate' and target_id = $1 order by created_at desc limit 1`, [benId])).rows[0].details).toMatchObject({ clientId: 'pforte-admin-ui' })
  })

  it('resets a password and signs the person out everywhere', async () => {
    await h.database.pool.query(`insert into oidc_payloads (id, type, payload, account_id) values ('ua-1', 1, '{}', $1)`, [benId])

    const page = await follow(await post(`/manage/users/${benId}/reset-password`))

    expect(page.body).toContain('A code to choose a new password was sent to Ben Keller.')
    expect((await h.database.pool.query(`select count(*)::int as n from oidc_payloads where account_id = $1`, [benId])).rows[0].n).toBe(0)
  })

  it('leads an administrator whose password it reset on to the administration, and nobody else anywhere', async () => {
    const reset = async () => {
      h.notifications.length = 0
      await h.database.pool.query('delete from otp_codes')
      await follow(await post(`/manage/users/${benId}/reset-password`))
      const { url, code } = h.notifications.findLast((n) => n.kind === 'reset-code')!
      // The person follows the link in the mail, in a browser that knows nothing of the administration.
      const browser = new Browser(h.app)
      const link = new URL(url!)
      const page = await browser.request('GET', `${link.pathname}${link.search}`)
      expect(page.statusCode, page.body).toBe(200)
      const clientId = link.searchParams.get('client_id')
      const chosen = await browser.request('POST', '/reset/code', {
        form: { email: 'ben.keller@example.com', code: code!, password: 'a long enough passphrase', confirm: 'a long enough passphrase', ...(clientId ? { client_id: clientId } : {}) },
      })
      expect(chosen.statusCode, chosen.body).toBe(200)
      expect(chosen.body).toContain('<h1>Password changed</h1>')
      return { form: page.body, page: chosen.body, clientId }
    }

    // somebody who is no administrator, and no application chosen for them: nothing says where they are going
    const person = await reset()
    expect(person.clientId).toBeNull()
    expect(person.page).not.toContain('Continue to')

    await h.database.pool.query(`update users set is_admin = true where id = $1`, [benId])
    const administrator = await reset()
    expect(administrator.clientId).toBe('pforte-admin-ui')
    // The page from the link hands the client on with the form, as the page of "Forgot your password?" does.
    expect(administrator.form).toContain('<input type="hidden" name="client_id" value="pforte-admin-ui">')
    expect(administrator.page).toContain('<a class="button" href="https://localhost:3300/manage">Continue to Administration</a>')
  })

  describe('the application a person is sent on to', () => {
    const SELECT = /<select id="clientId" name="clientId">\n([\s\S]*?)\n<\/select>/
    const optionsOf = (html: string) => SELECT.exec(html)?.[1]?.split('\n')
    const NONE = '<option value="">No application</option>'
    const BACKEND = '<option value="demo-backend">Demo backend (confidential client)</option>'
    const WEB = '<option value="demo-web">Demo web app (public client)</option>'
    const selected = (option: string) => option.replace('">', '" selected>')
    const created = () => h.database.pool.query(`update users set status = 'created', password_hash = null where id = $1`, [benId])
    /** Runs with only these applications having a start address, and puts the others back. */
    const withStartApplications = async (clientIds: string[], run: () => Promise<void>) => {
      const { rows } = await h.database.pool.query(`select client_id, client_uri from clients where system = false and client_uri is not null`)
      await h.database.pool.query(`update clients set client_uri = null where system = false and not (client_id = any($1))`, [clientIds])
      try {
        await run()
      } finally {
        for (const row of rows) await h.database.pool.query(`update clients set client_uri = $2 where client_id = $1`, [row.client_id, row.client_uri])
      }
    }
    /** What the person gets and ends on: the mail, and the page after choosing the password. */
    const activation = async () => {
      const { url, applicationName } = h.notifications.findLast((n) => n.kind === 'activation')!
      const page = await new Browser(h.app).request('POST', '/activate', {
        form: { token: new URL(url!).searchParams.get('token')!, password: 'a long enough passphrase', confirm: 'a long enough passphrase' },
      })
      expect(page.statusCode, page.body).toBe(200)
      return { applicationName, page: page.body }
    }

    it('is asked for with an activation link: the applications that have a start address, and none chosen where there are several', async () => {
      await created()
      const page = plain((await get(`/manage/users/${benId}/activate`)).body)
      expect(page).toContain('<label for="clientId">Application</label>')
      // Not the administration and the account pages, which have a start address too, nor a client without one.
      expect(optionsOf(page)).toEqual([selected(NONE), BACKEND, WEB])
      expect(page).toContain('<small class="muted">The e-mail names the application, and the page after choosing the password leads on to it.</small>')
    })

    it('is asked for with a password reset as well, in its own words', async () => {
      const page = plain((await get(`/manage/users/${benId}/reset-password`)).body)
      expect(optionsOf(page)).toEqual([selected(NONE), BACKEND, WEB])
      expect(page).toContain('<small class="muted">The page after choosing the new password leads on to the application.</small>')
    })

    it('is chosen already where there is exactly one, and can still be taken away', async () => {
      await created()
      await withStartApplications(['demo-web'], async () => {
        expect(optionsOf(plain((await get(`/manage/users/${benId}/activate`)).body))).toEqual([NONE, selected(WEB)])
      })
    })

    it('is not asked for where no application has a start address', async () => {
      await created()
      await withStartApplications([], async () => {
        const page = plain((await get(`/manage/users/${benId}/activate`)).body)
        expect(page).toContain('Send the activation link to Ben Keller?')
        expect(page).not.toContain('<select')
      })
    })

    it('is not asked for where the link leads to the administration, nor where nothing leads anywhere', async () => {
      await created()
      await h.database.pool.query(`update users set is_admin = true where id = $1`, [benId])
      expect((await get(`/manage/users/${benId}/activate`)).body).not.toContain('<select')
      await h.database.pool.query(`update users set is_admin = false, status = 'active', password_hash = 'x' where id = $1`, [benId])
      for (const action of ['lock', 'deactivate', 'end-sessions', 'delete']) expect((await get(`/manage/users/${benId}/${action}`)).body, action).not.toContain('<select')
    })

    it('goes into the activation link: the mail names the application and the page at the end leads on to it', async () => {
      await created()
      await follow(await post(`/manage/users/${benId}/activate`, { clientId: 'demo-web' }))
      const { applicationName, page } = await activation()
      expect(applicationName).toBe('Demo web app (public client)')
      expect(page).toContain('<a class="button" href="http://localhost:3400/">Continue to Demo web app (public client)</a>')
      expect((await h.audit('user.activate', benId)).at(-1).details).toMatchObject({ clientId: 'demo-web' })
    })

    it('can be left open: the mail names nothing, and the page at the end leads on only where there is one application', async () => {
      await created()
      await follow(await post(`/manage/users/${benId}/activate`, { clientId: '' }))
      const several = await activation()
      expect(several.applicationName).toBeUndefined()
      expect(several.page).toContain('<p>Your password is set. You can sign in now.</p>')
      expect(several.page).not.toContain('Continue to')

      await created()
      await withStartApplications(['demo-web'], async () => {
        await follow(await post(`/manage/users/${benId}/activate`, { clientId: '' }))
        const one = await activation()
        expect(one.applicationName).toBeUndefined()
        expect(one.page).toContain('<a class="button" href="http://localhost:3400/">Continue to Demo web app (public client)</a>')
      })
    })

    it('goes into the link of a password reset, and the page after the new password leads on to it', async () => {
      await follow(await post(`/manage/users/${benId}/reset-password`, { clientId: 'demo-web' }))
      const { url, code } = h.notifications.findLast((n) => n.kind === 'reset-code')!
      expect(new URL(url!).searchParams.get('client_id')).toBe('demo-web')
      const chosen = await new Browser(h.app).request('POST', '/reset/code', {
        form: { email: 'ben.keller@example.com', code: code!, password: 'a long enough passphrase', confirm: 'a long enough passphrase', client_id: 'demo-web' },
      })
      expect(chosen.body).toContain('<a class="button" href="http://localhost:3400/">Continue to Demo web app (public client)</a>')
    })

    it('says so and sends nothing where the application does not exist', async () => {
      await created()
      const refused = await post(`/manage/users/${benId}/activate`, { clientId: 'nothing-here' })
      expect(refused.statusCode).toBe(400)
      expect(refused.body).toContain('There is no client &quot;nothing-here&quot;.')
      // What was sent is not among the choices, so none is marked: the browser shows the first, "No application".
      expect(optionsOf(plain(refused.body))).toEqual([NONE, BACKEND, WEB])
      expect(h.notifications.filter((n) => n.kind === 'activation')).toEqual([])
    })

    it('keeps what was chosen where the mail could not be sent, so that it need not be chosen again', async () => {
      await created()
      h.notifier.failWith = new NotifierUnavailableError('the mail server is down')
      try {
        const failed = await post(`/manage/users/${benId}/activate`, { clientId: 'demo-web' })
        expect(failed.statusCode).toBeGreaterThanOrEqual(500)
        expect(optionsOf(plain(failed.body))).toEqual([NONE, BACKEND, selected(WEB)])
      } finally {
        h.notifier.failWith = undefined
      }
    })

    it('stays the administration for an administrator, whatever the form says', async () => {
      await created()
      await h.database.pool.query(`update users set is_admin = true where id = $1`, [benId])
      await follow(await post(`/manage/users/${benId}/activate`, { clientId: 'demo-web' }))
      const { applicationName, page } = await activation()
      expect(applicationName).toBe('Administration')
      expect(page).toContain('<a class="button" href="https://localhost:3300/manage">Continue to Administration</a>')
    })
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

    describe('passkeys', () => {
      const store = async (label: string | null, { synced = false, lastUsed = false } = {}) =>
        (
          await h.database.pool.query(`insert into passkeys (user_id, credential_id, public_key, label, synced, last_used_at) values ($1, $2, 'key', $3, $4, $5) returning id`, [
            benId,
            `credential-${label}`,
            label,
            synced,
            lastUsed ? new Date() : null,
          ])
        ).rows[0].id as string
      const panel = async () => {
        const page = plain((await get(`/manage/users/${benId}`)).body)
        return page.slice(page.indexOf('<h2>Passkeys</h2>'), page.indexOf('<h2>Remembered devices</h2>'))
      }

      beforeEach(async () => {
        await h.database.pool.query('delete from passkeys')
      })

      it('says so when the person has none', async () => {
        expect(await panel()).toContain('No passkey.')
      })

      it('lists them with the browser they were made with, whether they are synced and when they were last used', async () => {
        await store('Safari, iPhone', { synced: true, lastUsed: true })
        await store(null)

        const part = await panel()

        expect(part.match(/<tr><td>/g)).toHaveLength(2)
        expect(part).toContain('<td>Safari, iPhone <span class="badge synced">Synced</span></td>')
        expect(part).toContain('<td>Unknown browser</td>')
        expect(part).toContain('<td>Not yet</td>')
      })

      it('removes one, through the admin API, and says so', async () => {
        const removed = await store('Safari, iPhone')
        await store('Chrome, Windows')

        const page = await follow(await post(`/manage/users/${benId}/passkeys/${removed}/remove`))

        expect(page.body).toContain('The passkey was removed.')
        expect(await panel()).not.toContain('Safari, iPhone')
        expect(await panel()).toContain('Chrome, Windows')
        expect((await h.audit('user.passkey.remove', benId)).at(-1).details).toMatchObject({ passkeyId: removed })
      })

      it('answers "not found" for a passkey that is not this person\'s', async () => {
        expect((await post(`/manage/users/${benId}/passkeys/018f0000-0000-7000-8000-000000000000/remove`)).statusCode).toBe(404)
        expect((await post(`/manage/users/${benId}/passkeys/not-an-id/remove`)).statusCode).toBe(404)
      })
    })

    describe('applications that stay signed in', () => {
      const HEADING = '<h3>Applications that stay signed in</h3>'
      /** Stores a record of the person as the OIDC library would: 1 a browser session, 13 a grant, 4 a refresh token. */
      const store = (id: string, type: number, payload: Record<string, unknown>, grantId: string | null = null) =>
        h.database.pool.query(`insert into oidc_payloads (id, type, payload, account_id, grant_id, expires_at) values ($1, $2, $3, $4, $5, now() + interval '1 day')`, [
          id,
          type,
          JSON.stringify({ accountId: benId, ...payload }),
          benId,
          grantId,
        ])
      const panel = async () => {
        const page = plain((await get(`/manage/users/${benId}`)).body)
        return page.slice(page.indexOf('<h2>Signed in</h2>'), page.indexOf('<h2>Recent sign-ins</h2>'))
      }

      beforeEach(async () => {
        await h.database.pool.query(`delete from oidc_payloads where account_id = $1`, [benId])
      })

      it('does not list an application that is signed in only as long as its browser session lasts', async () => {
        await store('sess-web', 1, { loginTs: Math.floor(Date.now() / 1000), authorizations: { 'demo-web': { grantId: 'grant-web' } }, acr: 'urn:pforte:acr:mfa' })
        await store('grant-web', 13, { clientId: 'demo-web' })

        const part = await panel()

        // The application is in the table of browsers, and nowhere else.
        expect(part.match(/Demo web app \(public client\)/g)).toHaveLength(1)
        expect(part).not.toContain(HEADING)
      })

      it('lists the one that holds a refresh token, and not the one whose refresh token was used up', async () => {
        await store('grant-web', 13, { clientId: 'demo-web' })
        await store('refresh-web', 4, { clientId: 'demo-web' }, 'grant-web')
        await store('grant-backend', 13, { clientId: 'demo-backend' })
        await store('refresh-backend', 4, { clientId: 'demo-backend' }, 'grant-backend')
        await h.database.pool.query(`update oidc_payloads set consumed_at = now() where id = 'refresh-backend'`)

        const part = await panel()
        const staying = part.slice(part.indexOf(HEADING))

        expect(part).toContain(HEADING)
        expect(staying.match(/<tr><td>/g)).toHaveLength(1)
        expect(staying).toContain('<td>Demo web app (public client)</td>')
        expect(part).not.toContain('Demo backend')
      })

      it('says "not signed in anywhere" for a grant that is left over: no browser session, no refresh token', async () => {
        await store('grant-web', 13, { clientId: 'demo-web' })

        const part = await panel()

        expect(part).toContain('Not signed in anywhere.')
        expect(part).not.toContain('Demo web app')
      })
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
