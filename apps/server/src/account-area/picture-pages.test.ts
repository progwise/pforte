import { hasDatabase } from '@progwise/pforte-db/testing'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sign, unsign } from '../interaction/signed-cookie.js'
import { MAX_UPLOAD_BYTES, PICTURE_SIZE } from '../pictures/prepare.js'
import { type AdminHarness, createAdminHarness, ISSUER } from '../test/admin-harness.js'
import { basicAuth, Browser, signIn, verifyJwt } from '../test/browser.js'
import { driveSignIn } from '../test/manage-session.js'
import { cameraPicture, samplePicture } from '../test/pictures.js'

const COOKIE_KEYS = ['k'.repeat(40)]
/** Two people of the seed. Whatever one of them does must never be the other's. */
const A = { email: 'anna.schmidt@example.com' }
const B = { email: 'ben.keller@example.com' }
const PAGE = '/account/picture'
const FILE_FIELD = '<input id="picture" name="picture" type="file"'
const REMOVE = `<form class="below" method="post" action="${PAGE}/remove">`
const BACKEND = { clientId: 'demo-backend', redirectUri: 'http://localhost:3500/callback' }

describe.skipIf(!hasDatabase)('the picture of a person', () => {
  let h: AdminHarness
  let jpeg: Buffer

  beforeAll(async () => {
    h = await createAdminHarness()
    jpeg = await samplePicture()
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(async () => {
    await h.settle()
    h.notifications.length = 0
    await h.database.pool.query('delete from rate_limits')
    await h.database.pool.query('delete from otp_codes')
    await h.database.pool.query('delete from user_pictures')
    await h.database.pool.query(`delete from audit_events where action like 'login.%' or action like 'user.picture.%'`)
    await h.database.pool.query(`update users set picture_key = null, status = 'active', language = 'en' where email in ($1, $2)`, [A.email, B.email])
  })

  const userOf = async (email: string) => (await h.database.pool.query(`select id, picture_key from users where email = $1`, [email])).rows[0] as { id: string; picture_key: string | null }

  /** A browser in which this person is signed in to their account pages, a moment ago. */
  const signedIn = async (email: string) => {
    const browser = new Browser(h.app)
    const { response } = await driveSignIn(h, browser, '/account', email)
    expect(response.statusCode, response.body).toBe(200)
    return browser
  }
  /** Makes the sign-in of this browser look as if it happened so many seconds ago. */
  const age = (browser: Browser, seconds: number) => {
    const session = unsign<{ authTime: number }>(COOKIE_KEYS, browser.cookies.get('pforte_account'))!
    browser.cookies.set('pforte_account', sign(COOKIE_KEYS, { ...session, authTime: session.authTime - seconds }))
  }
  const sameOrigin = { 'sec-fetch-site': 'same-origin' }
  const upload = (browser: Browser, content: Buffer | string, name = 'me.jpg') => browser.request('POST', PAGE, { multipart: { file: { field: 'picture', name, content } }, headers: sameOrigin })
  const follow = async (browser: Browser, response: { headers: Record<string, unknown> }) => browser.request('GET', response.headers.location as string)
  const fetchPicture = (key: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url: `/pictures/${key}`, headers })
  /** The person has this picture: uploaded in a browser of theirs, which is returned. */
  const withPicture = async (email: string, content: Buffer = jpeg) => {
    const browser = await signedIn(email)
    expect((await upload(browser, content)).headers.location).toBe('/account')
    return { browser, key: (await userOf(email)).picture_key! }
  }

  describe('the overview', () => {
    it('offers somebody without a picture to add one, and says that it can be changed here', async () => {
      const page = await (await signedIn(A.email)).request('GET', '/account')

      expect(page.body).toContain(`<dt>Picture</dt><dd>None<br><a href="${PAGE}">Add a picture</a></dd>`)
      expect(page.body).not.toContain('class="avatar"')
      expect(page.body).toMatch(/only the (mobile number and the )?picture can be changed here\./)
    })

    it('shows the picture of the person who has one, and lets the page load it from pforte and from nowhere else', async () => {
      const { browser, key } = await withPicture(A.email)

      const page = await browser.request('GET', '/account')

      expect(page.body).toContain(`<img class="avatar" src="/pictures/${key}" alt="Your picture" width="96" height="96"><a href="${PAGE}">Change picture</a>`)
      expect(page.headers['content-security-policy']).toContain("img-src 'self'")
      expect(page.headers['content-security-policy']).toContain("default-src 'none'")
      expect(page.headers['content-security-policy']).not.toContain('script-src')
    })
  })

  describe('the page for the picture', () => {
    it('asks for a file, and says what happens to it and who can see it', async () => {
      const page = await (await signedIn(A.email)).request('GET', PAGE)

      expect(page.statusCode).toBe(200)
      expect(page.body).toContain(`<form method="post" enctype="multipart/form-data" action="${PAGE}">`)
      expect(page.body).toContain(`${FILE_FIELD} accept="image/jpeg,image/png,image/webp" required>`)
      expect(page.body).toContain('a JPEG, PNG or WebP file of at most 10 MB')
      expect(page.body).toContain('Whoever has that address can see the picture without signing in.')
      expect(page.body).not.toContain(REMOVE)
      expect(page.body).not.toContain('class="avatar"')
    })

    it('shows the picture the person has, and offers to remove it', async () => {
      const { browser, key } = await withPicture(A.email)

      const page = await browser.request('GET', PAGE)

      expect(page.body).toContain(`src="/pictures/${key}"`)
      expect(page.body).toContain(REMOVE)
      expect(page.headers['content-security-policy']).toContain("img-src 'self'")
    })

    it('asks for a new sign-in before the file is chosen when the last one is older than five minutes', async () => {
      const browser = await signedIn(A.email)
      age(browser, 301)

      const page = await browser.request('GET', PAGE)

      expect(page.statusCode).toBe(303)
      expect(page.headers.location).toBe(`/account/login?again=1&next=${encodeURIComponent(PAGE)}`)
    })
  })

  describe('uploading', () => {
    it('gives the person the picture, says so, and records it as their own doing', async () => {
      const browser = await signedIn(A.email)

      const saved = await upload(browser, jpeg)

      expect(saved.statusCode).toBe(303)
      expect(saved.headers.location).toBe('/account')
      expect((await follow(browser, saved)).body).toContain('Your picture was saved.')
      const user = await userOf(A.email)
      expect(user.picture_key).toMatch(/^[\w-]{22}$/)
      expect((await h.audit('user.picture.set', user.id)).at(-1)).toMatchObject({ actor_type: 'user', actor_id: user.id, details: { self: true, replaced: false } })
      expect((await userOf(B.email)).picture_key).toBeNull()
    })

    it.each(['png', 'webp'] as const)('takes a %s as well', async (format) => {
      const browser = await signedIn(A.email)

      expect((await upload(browser, await samplePicture({ format }), `me.${format}`)).headers.location).toBe('/account')

      expect((await fetchPicture((await userOf(A.email)).picture_key!)).headers['content-type']).toBe('image/jpeg')
    })

    it('serves what pforte made of the upload and not the upload: a square JPEG without what the camera noted', async () => {
      const taken = await cameraPicture()
      const { key } = await withPicture(A.email, taken)

      const served = await fetchPicture(key)

      expect(served.rawPayload.equals(taken)).toBe(false)
      expect(served.rawPayload.includes('Example Camera')).toBe(false)
      const made = await sharp(served.rawPayload).metadata()
      expect(made).toMatchObject({ format: 'jpeg', width: PICTURE_SIZE, height: PICTURE_SIZE })
      expect(made.exif).toBeUndefined()
    })

    it('replaces the picture: the new one has a new address, and the old address answers nothing', async () => {
      const { browser, key: first } = await withPicture(A.email)

      await upload(browser, await samplePicture({ color: '#00aa00' }))

      const { id, picture_key: second } = await userOf(A.email)
      expect(second).not.toBe(first)
      expect((await fetchPicture(first)).statusCode).toBe(404)
      expect((await fetchPicture(second!)).statusCode).toBe(200)
      expect((await h.audit('user.picture.set', id)).at(-1)!.details).toMatchObject({ replaced: true })
    })

    it.each([
      ['a text file', async () => Buffer.from('not a picture'), 'notes.txt'],
      ['a GIF', () => samplePicture({ format: 'gif' }), 'me.gif'],
      ['an SVG with a script, named like a JPEG', async () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'me.jpg'],
      ['a file that only begins like a JPEG', async () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('<script>alert(1)</script>')]), 'me.jpg'],
    ])('refuses %s, says so and keeps the picture the person had', async (_name, content, name) => {
      const { browser, key } = await withPicture(A.email)

      const refused = await upload(browser, await content(), name)

      expect(refused.statusCode).toBe(303)
      expect(refused.headers.location).toBe(PAGE)
      expect((await follow(browser, refused)).body).toContain('This file could not be read as a picture. Choose a JPEG, PNG or WebP file.')
      const user = await userOf(A.email)
      expect(user.picture_key).toBe(key)
      expect(await h.audit('user.picture.set', user.id)).toHaveLength(1)
    })

    it('refuses a file that is larger than a picture may be', async () => {
      const browser = await signedIn(A.email)

      const refused = await upload(browser, Buffer.concat([jpeg, Buffer.alloc(MAX_UPLOAD_BYTES)]))

      expect(refused.headers.location).toBe(PAGE)
      expect((await follow(browser, refused)).body).toContain('The file is larger than 10 MB.')
      expect((await userOf(A.email)).picture_key).toBeNull()
    })

    it.each([
      ['an empty file', (browser: Browser) => upload(browser, Buffer.alloc(0))],
      ['a form without a file', (browser: Browser) => browser.request('POST', PAGE, { form: { picture: 'me.jpg' }, headers: sameOrigin })],
      ['a file under another name', (browser: Browser) => browser.request('POST', PAGE, { multipart: { file: { field: 'other', name: 'me.jpg', content: jpeg } }, headers: sameOrigin })],
      ['a form with fields this page does not have', (browser: Browser) => browser.request('POST', PAGE, { multipart: { fields: { extra: 'x' }, file: { field: 'picture', name: 'me.jpg', content: jpeg } }, headers: sameOrigin })],
    ])('asks for a file when it gets %s', async (_name, send) => {
      const browser = await signedIn(A.email)

      const refused = await send(browser)

      expect(refused.statusCode).toBe(303)
      expect(refused.headers.location).toBe(PAGE)
      expect((await follow(browser, refused)).body).toContain('Choose a picture file first.')
      expect((await userOf(A.email)).picture_key).toBeNull()
    })

    it('does nothing without a sign-in, from another site, or when the sign-in is older than five minutes', async () => {
      const browser = await signedIn(A.email)

      expect((await upload(new Browser(h.app), jpeg)).headers.location).toBe('/account/login')
      expect((await browser.request('POST', PAGE, { multipart: { file: { field: 'picture', name: 'me.jpg', content: jpeg } }, headers: { 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403)
      age(browser, 301)
      expect((await upload(browser, jpeg)).headers.location).toBe(`/account/login?again=1&next=${encodeURIComponent(PAGE)}`)

      expect((await userOf(A.email)).picture_key).toBeNull()
    })

    it('holds back somebody who uploads picture after picture, and nobody else', async () => {
      const browser = await signedIn(A.email)
      for (let count = 0; count < 10; count++) expect((await upload(browser, jpeg)).headers.location).toBe('/account')
      const { picture_key: last } = await userOf(A.email)

      const held = await upload(browser, jpeg)

      expect(held.statusCode).toBe(429)
      expect(Number(held.headers['retry-after'])).toBeGreaterThan(0)
      expect((await userOf(A.email)).picture_key).toBe(last)
      expect((await upload(await signedIn(B.email), jpeg)).headers.location).toBe('/account')
    })
  })

  describe('removing', () => {
    it('takes the picture away: its address answers nothing, and it is recorded as the person’s own doing', async () => {
      const { browser, key } = await withPicture(A.email)

      const removed = await browser.request('POST', `${PAGE}/remove`, { headers: sameOrigin })

      expect(removed.headers.location).toBe('/account')
      expect((await follow(browser, removed)).body).toContain('Your picture was removed.')
      const user = await userOf(A.email)
      expect(user.picture_key).toBeNull()
      expect((await fetchPicture(key)).statusCode).toBe(404)
      expect((await h.audit('user.picture.remove', user.id)).at(-1)).toMatchObject({ actor_type: 'user', actor_id: user.id, details: { self: true } })
    })

    it('is no error for somebody who has none, and leaves everybody else’s alone', async () => {
      const { key } = await withPicture(B.email)
      const browser = await signedIn(A.email)

      expect((await browser.request('POST', `${PAGE}/remove`, { headers: sameOrigin })).headers.location).toBe('/account')

      expect(await h.audit('user.picture.remove', (await userOf(A.email)).id)).toEqual([])
      expect((await userOf(B.email)).picture_key).toBe(key)
    })
  })

  describe('the address of a picture', () => {
    it('answers without a sign-in, as a JPEG that may be shown anywhere and kept for a day', async () => {
      const { key } = await withPicture(A.email)

      const served = await fetchPicture(key)

      expect(served.statusCode).toBe(200)
      expect(served.headers).toMatchObject({
        'content-type': 'image/jpeg',
        'cache-control': 'public, max-age=86400',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cross-origin-resource-policy': 'cross-origin',
        etag: `"${key}"`,
      })
      expect(served.headers['set-cookie']).toBeUndefined()
    })

    it('says that nothing changed to somebody who has the picture already', async () => {
      const { key } = await withPicture(A.email)

      const again = await fetchPicture(key, { 'if-none-match': `"${key}"` })

      expect(again.statusCode).toBe(304)
      expect(again.rawPayload).toHaveLength(0)
    })

    it.each(['x'.repeat(22), 'short', `${'x'.repeat(21)}%2F`, 'x'.repeat(23)])('answers nothing for %s, and that is not kept', async (key) => {
      const served = await fetchPicture(key)

      expect(served.statusCode).toBe(404)
      expect(served.headers['cache-control']).toBe('no-store')
    })

    it('answers nothing while the person is locked', async () => {
      const { key } = await withPicture(A.email)
      await h.database.pool.query(`update users set status = 'locked' where email = $1`, [A.email])

      expect((await fetchPicture(key)).statusCode).toBe(404)
    })
  })

  describe('what applications get', () => {
    const claimsFor = async (email: string, scope: string) => {
      const browser = new Browser(h.app)
      const { code, verifier } = await signIn(browser, { ...BACKEND, scope, email })
      const tokens = (
        await browser.request('POST', '/token', {
          form: { grant_type: 'authorization_code', code: code!, redirect_uri: BACKEND.redirectUri, client_id: BACKEND.clientId, code_verifier: verifier },
          headers: { authorization: basicAuth('demo-backend', 'dev-secret') },
        })
      ).json()
      const userinfo = (await browser.request('GET', '/me', { headers: { authorization: `Bearer ${tokens.access_token}` } })).json()
      return { idToken: (await verifyJwt(h.app, tokens.id_token)).claims, userinfo }
    }

    it('is the address of the picture as the claim `picture`, with the scope profile', async () => {
      const { key } = await withPicture(A.email)

      const { idToken, userinfo } = await claimsFor(A.email, 'openid profile')

      expect(idToken.picture).toBe(`${ISSUER}/pictures/${key}`)
      expect(userinfo.picture).toBe(`${ISSUER}/pictures/${key}`)
    })

    it('is no claim for a person without a picture, and none without the scope profile', async () => {
      await withPicture(A.email)

      const without = await claimsFor(B.email, 'openid profile')
      const otherScope = await claimsFor(A.email, 'openid phone')

      expect(without.idToken).not.toHaveProperty('picture')
      expect(without.userinfo).not.toHaveProperty('picture')
      expect(without.userinfo).toHaveProperty('given_name')
      expect(otherScope.idToken).not.toHaveProperty('picture')
      expect(otherScope.userinfo).not.toHaveProperty('picture')
    })

    it('is named in the discovery document', async () => {
      expect((await h.app.inject({ method: 'GET', url: '/.well-known/openid-configuration' })).json().claims_supported).toContain('picture')
    })
  })

  describe('the back office', () => {
    it('sees in the admin API whether a person has a picture, and where', async () => {
      const { key } = await withPicture(A.email)
      const anna = await userOf(A.email)
      const ben = await userOf(B.email)

      expect((await h.api('GET', `/users/${anna.id}`)).json()).toMatchObject({ picture: `${ISSUER}/pictures/${key}` })
      expect((await h.api('GET', `/users/${ben.id}`)).json()).toMatchObject({ picture: null })
    })

    it('removes a picture through the admin API, and that is recorded as the back office’s doing', async () => {
      const { key } = await withPicture(A.email)
      const { id } = await userOf(A.email)

      const removed = await h.api('DELETE', `/users/${id}/picture`, { token: h.directoryToken })

      expect(removed.statusCode, removed.body).toBe(204)
      expect((await fetchPicture(key)).statusCode).toBe(404)
      expect((await h.api('GET', `/users/${id}`)).json().picture).toBeNull()
      const event = (await h.audit('user.picture.remove', id)).at(-1)
      expect(event).toMatchObject({ actor_type: 'client', actor_id: 'demo-import' })
      expect(event.details.self).toBeUndefined()
    })

    it('is told when there is no picture or no such user, and cannot set one', async () => {
      const { id } = await userOf(A.email)

      expect((await h.api('DELETE', `/users/${id}/picture`)).json()).toMatchObject({ status: 404, detail: 'The user has no picture.' })
      expect((await h.api('DELETE', '/users/0190f6a8-0000-7000-8000-000000000000/picture')).json()).toMatchObject({ status: 404, detail: 'There is no such user.' })
      expect((await h.api('DELETE', `/users/${id}/picture`, { token: null })).statusCode).toBe(401)
      expect((await h.api('PATCH', `/users/${id}`, { body: { picture: 'https://example.com/a.jpg' } })).json().picture ?? null).toBeNull()
      expect((await h.api('PUT', `/users/${id}/picture`, { body: {} })).statusCode).toBe(404)
    })

    it('sees the picture on the person’s page in the administration and removes it there', async () => {
      const { key } = await withPicture(A.email)
      const { id } = await userOf(A.email)
      const admin = new Browser(h.app)
      await driveSignIn(h, admin)

      const page = await admin.request('GET', `/manage/users/${id}`)
      expect(page.body).toContain(`<img class="avatar" src="${ISSUER}/pictures/${key}" alt="Picture of Anna Schmidt" width="96" height="96">`)
      expect(page.headers['content-security-policy']).toContain("img-src 'self'")
      const removed = await admin.request('POST', `/manage/users/${id}/picture/remove`, { headers: sameOrigin })

      expect(removed.headers.location).toBe(`/manage/users/${id}`)
      const after = await follow(admin, removed)
      expect(after.body).toContain('The picture was removed.')
      expect(after.body).not.toContain('class="avatar"')
      expect((await userOf(A.email)).picture_key).toBeNull()
    })
  })
})
