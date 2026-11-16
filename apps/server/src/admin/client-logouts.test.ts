import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { failureReason } from '../oidc/client-logouts.js'
import { type AdminHarness, createAdminHarness, ISSUER } from '../test/admin-harness.js'
import { basicAuth, Browser, signIn, verifyJwt } from '../test/browser.js'

const WEB = { clientId: 'demo-web', redirectUri: 'http://localhost:3400/callback' }
const BACKEND = { clientId: 'demo-backend', redirectUri: 'http://localhost:3500/callback' }
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout'

/** An application's logout address: keeps what it was sent and answers as it is told to. */
const createReceiver = async () => {
  const requests: { path: string; logoutToken: string }[] = []
  const state = {
    /** The status of the next answers, in order; 200 once they are used up. */
    answers: [] as number[],
    /** While set, answers wait for it: an application that is slow. */
    hold: undefined as Promise<void> | undefined,
  }
  const server: Server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', async () => {
      requests.push({ path: request.url ?? '', logoutToken: new URLSearchParams(body).get('logout_token') ?? '' })
      const status = state.answers.shift() ?? 200
      await state.hold
      response.writeHead(status).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    requests,
    state,
    address: (path: string) => `http://127.0.0.1:${port}${path}`,
    to: (path: string) => requests.filter((request) => request.path === path),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe.skipIf(!hasDatabase)('back-channel logout when sessions are ended for a user', () => {
  let h: AdminHarness
  let receiver: Awaited<ReturnType<typeof createReceiver>>

  beforeAll(async () => {
    h = await createAdminHarness({ allowPrivateAddresses: true })
    receiver = await createReceiver()
  })

  afterAll(async () => {
    await h?.close()
    await receiver?.close()
  })

  beforeEach(async () => {
    await h.settle()
    receiver.requests.length = 0
    receiver.state.answers = []
    receiver.state.hold = undefined
    h.logoutFailures.length = 0
    h.notifications.length = 0
    // The usual setting: the web application takes "all sessions of this person", the backend wants the session named.
    await setAddress(WEB.clientId, receiver.address('/web'), false)
    await setAddress(BACKEND.clientId, receiver.address('/backend'), true)
  })

  const setAddress = async (clientId: string, backchannelLogoutUri: string | null, backchannelLogoutSessionRequired = false) => {
    const response = await h.api('PATCH', `/clients/${clientId}`, { body: { backchannelLogoutUri, backchannelLogoutSessionRequired } })
    expect(response.statusCode, response.body).toBe(200)
  }

  const seeded = async (name: string) => (await h.api('GET', `/users?search=${name}@example.com`)).json().items[0] as { id: string; email: string }

  /** Signs the person in to an application in a browser of its own and returns the ID token the application got. */
  const signInTo = async (email: string, client: typeof WEB) => {
    const browser = new Browser(h.app)
    const { code, verifier } = await signIn(browser, { ...client, email })
    expect(code, 'the sign-in should end with a code').toBeTruthy()
    const confidential = client.clientId === BACKEND.clientId
    const response = await browser.request('POST', '/token', {
      ...(confidential ? { headers: { authorization: basicAuth(client.clientId, 'dev-secret') } } : {}),
      form: { grant_type: 'authorization_code', code: code!, redirect_uri: client.redirectUri, code_verifier: verifier, ...(confidential ? {} : { client_id: client.clientId }) },
    })
    expect(response.statusCode, response.body).toBe(200)
    return (await verifyJwt(h.app, response.json().id_token)).claims as { sub: string; sid?: string }
  }

  const act = (id: string, action: string) => h.api('POST', `/users/${id}/${action}`)
  /** A seeded person who is signed in nowhere, whatever an earlier test left behind, and a receiver that has seen nothing. */
  const signedOut = async (name: string) => {
    const user = await seeded(name)
    await act(user.id, 'end-sessions')
    await h.settle()
    receiver.requests.length = 0
    receiver.state.answers = []
    h.logoutFailures.length = 0
    return user
  }
  const claimsOf = async (logoutToken: string) => {
    const { valid, claims } = await verifyJwt(h.app, logoutToken)
    expect(valid, 'the logout token is signed with a published key').toBe(true)
    return claims as { iss: string; aud: string; sub: string; sid?: string; jti: string; iat: number; events: Record<string, unknown> }
  }
  const failures = async (userId: string) => (await h.audit('user.sessions.notify_failed', userId)).map((event) => ({ actorType: event.actor_type, ...event.details }))

  it('lock: each application gets a signed logout token, with the session ID where the application asked for it', async () => {
    const user = await seeded('anna.schmidt')
    await signInTo(user.email, WEB)
    const atBackend = await signInTo(user.email, BACKEND)

    expect((await act(user.id, 'lock')).statusCode).toBe(200)
    await h.settle()

    expect(receiver.requests).toHaveLength(2)
    const web = await claimsOf(receiver.to('/web')[0]!.logoutToken)
    expect(web).toMatchObject({ iss: ISSUER, aud: WEB.clientId, sub: user.id, events: { [LOGOUT_EVENT]: {} } })
    // No session named: all sessions of this person at the application.
    expect(web.sid).toBeUndefined()
    expect(web.jti).toBeTruthy()

    const backend = await claimsOf(receiver.to('/backend')[0]!.logoutToken)
    expect(backend).toMatchObject({ iss: ISSUER, aud: BACKEND.clientId, sub: user.id, events: { [LOGOUT_EVENT]: {} } })
    // The same session ID the application found in the ID token.
    expect(atBackend.sid).toBeTruthy()
    expect(backend.sid).toBe(atBackend.sid)

    expect((await h.audit('user.lock', user.id))[0].details).toMatchObject({ clientsToNotify: 2 })
    expect(await failures(user.id)).toEqual([])
  })

  it.each([
    ['deactivate', 'ben.keller', 'user.deactivate'],
    ['end-sessions', 'david.roth', 'user.sessions.end'],
    ['reset-password', 'emma.vogel', 'user.password_reset.request'],
  ] as const)('%s: the application is told', async (action, name, recorded) => {
    const user = await seeded(name)
    await signInTo(user.email, WEB)

    expect((await act(user.id, action)).statusCode).toBe(200)
    await h.settle()

    expect(receiver.requests).toHaveLength(1)
    expect(await claimsOf(receiver.to('/web')[0]!.logoutToken)).toMatchObject({ aud: WEB.clientId, sub: user.id })
    expect((await h.audit(recorded, user.id)).at(-1).details).toMatchObject({ clientsToNotify: 1 })
  })

  it('delete: the application is told about a person who no longer exists', async () => {
    const user = await seeded('carla.berger')
    await signInTo(user.email, WEB)

    expect((await h.api('DELETE', `/users/${user.id}`)).statusCode).toBe(204)
    await h.settle()

    expect(receiver.requests).toHaveLength(1)
    expect(await claimsOf(receiver.to('/web')[0]!.logoutToken)).toMatchObject({ aud: WEB.clientId, sub: user.id })
    expect((await h.audit('user.delete', user.id))[0].details).toMatchObject({ clientsToNotify: 1 })
  })

  it('a completed password reset: the application is told', async () => {
    const user = await seeded('felix.brandt')
    await signInTo(user.email, WEB)
    const page = new Browser(h.app)
    await page.request('POST', '/reset', { form: { email: user.email } })
    await h.settle()
    expect(receiver.requests).toEqual([])

    const done = await page.request('POST', '/reset/code', {
      form: { email: user.email, code: h.lastResetCode(user.email)!, password: 'a brand new password', confirm: 'a brand new password' },
    })
    expect(done.statusCode, done.body).toBe(200)
    await h.settle()

    expect(receiver.requests).toHaveLength(1)
    expect(await claimsOf(receiver.to('/web')[0]!.logoutToken)).toMatchObject({ aud: WEB.clientId, sub: user.id })
    expect((await h.audit('user.password_reset.complete', user.id))[0].details).toMatchObject({ clientsToNotify: 1 })
  })

  it('tells no application without a logout address, and nobody for a person who is signed in nowhere', async () => {
    const user = await seeded('greta.lang')
    await setAddress(WEB.clientId, null)
    await signInTo(user.email, WEB)

    expect((await act(user.id, 'end-sessions')).statusCode).toBe(200)
    await h.settle()
    expect(receiver.requests).toEqual([])
    expect((await h.audit('user.sessions.end', user.id)).at(-1).details).toMatchObject({ clientsToNotify: 0 })

    // The address is back, but the sessions are gone: there is nobody left to tell.
    await setAddress(WEB.clientId, receiver.address('/web'))
    expect((await act(user.id, 'end-sessions')).statusCode).toBe(200)
    await h.settle()
    expect(receiver.requests).toEqual([])
  })

  it('tells an application that kept its tokens after the browser session at pforte was gone', async () => {
    const user = await seeded('jonas.fuchs')
    await signInTo(user.email, WEB)
    const atBackend = await signInTo(user.email, BACKEND)
    await h.database.pool.query(`delete from oidc_payloads where account_id = $1 and type = 1`, [user.id])

    expect((await act(user.id, 'end-sessions')).statusCode).toBe(200)
    await h.settle()

    expect(receiver.requests.map((request) => request.path).sort()).toEqual(['/backend', '/web'])
    // The backend asked for the session ID. The session is gone, but its tokens still name it.
    expect(atBackend.sid).toBeTruthy()
    expect((await claimsOf(receiver.to('/backend')[0]!.logoutToken)).sid).toBe(atBackend.sid)
    expect((await h.audit('user.sessions.end', user.id)).at(-1).details).toMatchObject({ clientsToNotify: 2 })
  })

  it('does not tell an application that asked for the session ID when only a grant is left: there is no ID to name', async () => {
    const user = await seeded('jonas.fuchs')
    await signInTo(user.email, BACKEND)
    // Neither the session nor a token: types 1 (session), 2 (access token), 3 (code) and 4 (refresh token).
    await h.database.pool.query(`delete from oidc_payloads where account_id = $1 and type in (1, 2, 3, 4)`, [user.id])

    expect((await act(user.id, 'end-sessions')).statusCode).toBe(200)
    await h.settle()

    expect(receiver.requests).toEqual([])
    expect((await h.audit('user.sessions.end', user.id)).at(-1).details).toMatchObject({ sessionsEnded: 1, clientsToNotify: 0 })
  })

  describe('an application that does not answer as it should', () => {
    it('does not hold the action up: the answer is there before the application has answered', async () => {
      const user = await signedOut('hans.weber')
      await signInTo(user.email, WEB)
      let release!: () => void
      receiver.state.hold = new Promise<void>((resolve) => (release = resolve))

      const ended = await act(user.id, 'end-sessions')

      expect(ended.statusCode).toBe(200)
      expect(ended.json()).toMatchObject({ sessionsEnded: expect.any(Number) })
      release()
      await h.settle()
      expect(receiver.requests).toHaveLength(1)
    })

    it('is asked three times and then given up on, with an audit event that names it', async () => {
      const user = await signedOut('hans.weber')
      await signInTo(user.email, WEB)
      receiver.state.answers = [500, 500, 500, 500, 500]

      expect((await act(user.id, 'end-sessions')).statusCode).toBe(200)
      await h.settle()

      expect(receiver.requests).toHaveLength(3)
      // A new token for every attempt: an application may refuse one it has seen.
      expect(new Set(receiver.requests.map((request) => request.logoutToken)).size).toBe(3)
      expect(h.logoutFailures).toEqual([{ clientId: WEB.clientId, reason: 'http_500', attempts: 3 }])
      expect(await failures(user.id)).toEqual([{ actorType: 'system', email: user.email, clientId: WEB.clientId, reason: 'http_500', attempts: 3 }])
      // The sessions ended all the same.
      expect((await h.api('GET', `/users/${user.id}/sessions`)).json()).toMatchObject({ sessions: [], grants: [] })
    })

    it('is asked again and told at the second attempt, without an audit event', async () => {
      const user = await signedOut('ida.sommer')
      await signInTo(user.email, WEB)
      receiver.state.answers = [503]

      expect((await act(user.id, 'end-sessions')).statusCode).toBe(200)
      await h.settle()

      expect(receiver.requests).toHaveLength(2)
      expect(h.logoutFailures).toEqual([])
      expect(await failures(user.id)).toEqual([])
    })

    it('is not asked again once the person has signed in anew: a late "all sessions" would end the new one', async () => {
      const user = await signedOut('ida.sommer')
      await signInTo(user.email, WEB)
      let release!: () => void
      receiver.state.hold = new Promise<void>((resolve) => (release = resolve))
      receiver.state.answers = [500]

      expect((await act(user.id, 'end-sessions')).statusCode).toBe(200)
      // The first call is on its way and will fail. Meanwhile the person signs in to the application again.
      await expect.poll(() => receiver.requests.length).toBe(1)
      await signInTo(user.email, WEB)
      release()
      await h.settle()

      // No second call: its token would be dated after the new sign-in and name no session.
      expect(receiver.requests).toHaveLength(1)
      expect(await failures(user.id)).toContainEqual({ actorType: 'system', email: user.email, clientId: WEB.clientId, reason: 'signed_in_again', attempts: 1 })
      // The new sign-in is untouched at pforte too.
      expect((await h.api('GET', `/users/${user.id}/sessions`)).json().grants).toEqual([expect.objectContaining({ clientId: WEB.clientId })])
    })

    it('is asked again after a new sign-in when the logout names the old session: that cannot end the new one', async () => {
      const user = await signedOut('ida.sommer')
      const before = await signInTo(user.email, BACKEND)
      let release!: () => void
      receiver.state.hold = new Promise<void>((resolve) => (release = resolve))
      receiver.state.answers = [500]

      expect((await act(user.id, 'end-sessions')).statusCode).toBe(200)
      await expect.poll(() => receiver.requests.length).toBe(1)
      const after = await signInTo(user.email, BACKEND)
      release()
      await h.settle()

      expect(receiver.requests).toHaveLength(2)
      const retried = await claimsOf(receiver.requests[1]!.logoutToken)
      expect(retried.sid).toBe(before.sid)
      expect(retried.sid).not.toBe(after.sid)
    })

    it('is not asked again after a new sign-in when it stopped asking for the session ID meanwhile: the retry would name none', async () => {
      const user = await signedOut('ida.sommer')
      await signInTo(user.email, BACKEND)
      let release!: () => void
      receiver.state.hold = new Promise<void>((resolve) => (release = resolve))
      receiver.state.answers = [500]

      expect((await act(user.id, 'end-sessions')).statusCode).toBe(200)
      await expect.poll(() => receiver.requests.length).toBe(1)
      expect((await claimsOf(receiver.requests[0]!.logoutToken)).sid).toBeTruthy()
      // An administrator changes the client, and the person signs in again, before the second attempt.
      await setAddress(BACKEND.clientId, receiver.address('/backend'), false)
      await signInTo(user.email, BACKEND)
      release()
      await h.settle()

      // The queued logout names a session, but the token built now would not.
      expect(receiver.requests).toHaveLength(1)
      expect(await failures(user.id)).toContainEqual({ actorType: 'system', email: user.email, clientId: BACKEND.clientId, reason: 'signed_in_again', attempts: 1 })
    })

    it('is asked again without the session ID when it stopped asking for it and the person stayed signed out', async () => {
      const user = await signedOut('ida.sommer')
      await signInTo(user.email, BACKEND)
      let release!: () => void
      receiver.state.hold = new Promise<void>((resolve) => (release = resolve))
      receiver.state.answers = [500]

      expect((await act(user.id, 'end-sessions')).statusCode).toBe(200)
      await expect.poll(() => receiver.requests.length).toBe(1)
      await setAddress(BACKEND.clientId, receiver.address('/backend'), false)
      release()
      await h.settle()

      // Nobody signed in again, so "all sessions of this person" ends nothing it should not.
      expect(receiver.requests).toHaveLength(2)
      expect((await claimsOf(receiver.requests[1]!.logoutToken)).sid).toBeUndefined()
      expect(h.logoutFailures).toEqual([])
    })

    it('whose address is removed while pforte is still trying is recorded, not passed over', async () => {
      const user = await signedOut('ida.sommer')
      await signInTo(user.email, WEB)
      let release!: () => void
      receiver.state.hold = new Promise<void>((resolve) => (release = resolve))
      receiver.state.answers = [500]

      expect((await act(user.id, 'end-sessions')).statusCode).toBe(200)
      await expect.poll(() => receiver.requests.length).toBe(1)
      await setAddress(WEB.clientId, null)
      release()
      await h.settle()

      expect(receiver.requests).toHaveLength(1)
      expect(await failures(user.id)).toContainEqual({ actorType: 'system', email: user.email, clientId: WEB.clientId, reason: 'address_removed', attempts: 1 })
    })

    it('that cannot be reached at all is recorded as unreachable, and the other application is still told', async () => {
      const user = await signedOut('ida.sommer')
      await signInTo(user.email, WEB)
      await signInTo(user.email, BACKEND)
      // Nothing listens there: the port of a receiver that was closed again.
      const gone = await createReceiver()
      await gone.close()
      await setAddress(WEB.clientId, gone.address('/web'))

      expect((await act(user.id, 'end-sessions')).statusCode).toBe(200)
      await h.settle()

      expect(receiver.requests.map((request) => request.path)).toEqual(['/backend'])
      expect(await failures(user.id)).toContainEqual({ actorType: 'system', email: user.email, clientId: WEB.clientId, reason: 'unreachable', attempts: 3 })
    })
  })
})

describe.skipIf(!hasDatabase)('back-channel logout to a private address that is not allowed', () => {
  let h: AdminHarness
  let receiver: Awaited<ReturnType<typeof createReceiver>>

  beforeAll(async () => {
    h = await createAdminHarness()
    receiver = await createReceiver()
  })

  afterAll(async () => {
    await h?.close()
    await receiver?.close()
  })

  it('is refused as at a sign-out, once, and recorded', async () => {
    // The admin API would not take this address; it stands for one that became private later (DNS).
    await h.database.pool.query(`update clients set backchannel_logout_uri = $1 where client_id = $2`, [receiver.address('/web'), WEB.clientId])
    await h.provider.reload()
    const user = (await h.api('GET', '/users?search=anna.schmidt@example.com')).json().items[0] as { id: string; email: string }
    const { code } = await signIn(new Browser(h.app), { ...WEB, email: user.email })
    expect(code).toBeTruthy()

    expect((await h.api('POST', `/users/${user.id}/end-sessions`)).statusCode).toBe(200)
    await h.settle()

    expect(receiver.requests).toEqual([])
    expect(h.logoutFailures).toEqual([{ clientId: WEB.clientId, reason: 'private_address', attempts: 1 }])
    expect((await h.audit('user.sessions.notify_failed', user.id)).map((event) => event.details)).toEqual([
      { email: user.email, clientId: WEB.clientId, reason: 'private_address', attempts: 1 },
    ])
  })
})

describe('why a logout call failed', () => {
  it('names the status, a timeout, a refused private address, or that nothing answered', () => {
    expect(failureReason(Object.assign(new Error('expected 200 OK'), { response: { status: 502 } }))).toBe('http_502')
    expect(failureReason(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))).toBe('timeout')
    expect(failureReason(new TypeError('fetch failed', { cause: new Error('hostname resolves to a special-use IP address') }))).toBe('private_address')
    expect(failureReason(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') }))).toBe('unreachable')
    expect(failureReason('something else')).toBe('unreachable')
  })
})
