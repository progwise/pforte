import { generateKeyPairSync } from 'node:crypto'
import { getDatabaseTime } from '@progwise/pforte-db'
import { seed } from '@progwise/pforte-db/seed'
import { createTestDatabase } from '@progwise/pforte-db/testing'
import { expect } from 'vitest'
import { buildApp } from '../app.js'
import { createAuthenticate } from '../auth/authenticate.js'
import { deriveCodeSecrets } from '../auth/code-secrets.js'
import { createBackground } from '../security/background.js'
import { ensureAdminUiClient } from '../manage/setup.js'
import { ensureAccountUiClient } from '../account-area/setup.js'
import { createLoginAudit } from '../auth/login-audit.js'
import { createRateLimiter } from '../auth/rate-limiter.js'
import { createPasswordResetSender } from '../auth/password-reset.js'
import { createUi } from '../ui/index.js'
import { createClientLogouts } from '../oidc/client-logouts.js'
import { createProviderHolder } from '../oidc/provider.js'
import { createPasskeys } from '../passkeys/index.js'
import { ADMIN_UI_CLIENT_ID } from '../manage/constants.js'
import { basicAuth, Browser, registerCodeSource, signIn } from './browser.js'
import { createRecordingNotifier } from './recording-notifier.js'

export const ISSUER = 'https://localhost:3300'
const COOKIE_KEYS = ['k'.repeat(40)]

/** A seeded test database with the whole app (provider, login and admin API) on top of it. */
export const createAdminHarness = async ({
  selfServiceActivation = true,
  /** `ACTIVATION_LINK_DAYS` in milliseconds; the seven days of the default if not given. */
  activationValidityMs = undefined as number | undefined,
  allowPrivateAddresses = false,
  logoutPausesMs = [10, 10],
  /** The address pforte believes it has. A test with a real browser gives the one it listens on. */
  issuer = ISSUER,
  /** Whether there are account pages; without them the mail about a new passkey has no link. */
  accountPages = true,
} = {}) => {
  const database = await createTestDatabase()
  await seed(database.db)

  await ensureAdminUiClient(database.db, issuer)
  await ensureAccountUiClient(database.db, issuer)

  const jwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' })
  const ui = createUi()
  const limiter = createRateLimiter({ db: database.db, secret: 'rate-limit-test-secret' })
  const background = createBackground({ onError: (error) => backgroundErrors.push(error) })
  const backgroundErrors: unknown[] = []
  const loginAudit = createLoginAudit({ db: database.db, secret: 'audit-test-secret' })
  const provider = await createProviderHolder({
    config: {
      issuer,
      cookieKeys: COOKIE_KEYS,
      jwks: { keys: [{ ...jwk, kty: 'RSA', kid: 'test-key', alg: 'RS256', use: 'sig' }] },
      // As in the server: what lets such an address be registered also lets it be called.
      allowPrivateAddresses,
    },
    db: database.db,
  })
  /** Tells applications of ended sessions as the server does, but without its pauses between the attempts. */
  const logoutFailures: { clientId: string; reason: string; attempts: number }[] = []
  const clientLogouts = createClientLogouts({ db: database.db, provider, background, pausesMs: logoutPausesMs, onFailure: (failure) => logoutFailures.push(failure) })
  /** Everything the app asked the notifier to send, and a switch to make sending fail. */
  const { notifier, notifications, lastCode, lastResetCode, lastPhoneCode } = createRecordingNotifier()
  const sendPasswordResetCode = createPasswordResetSender({ db: database.db, notifier, codeSecrets: deriveCodeSecrets(COOKIE_KEYS), issuer })
  const passkeys = createPasskeys({ issuer, ui, db: database.db, notifier, background, cookieKeys: COOKIE_KEYS, name: 'Example Inc.', accountPages })
  const accountArea = { db: database.db, issuer, cookieKeys: COOKIE_KEYS, ui, timeZone: 'Europe/Berlin', clientLogouts, sendPasswordResetCode, limiter, audit: loginAudit, passkeys, notifier, codeSecrets: deriveCodeSecrets(COOKIE_KEYS), background }
  const app = buildApp({
    ui,
    issuer,
    passkeys,
    pictures: { db: database.db },
    getDatabaseTime: () => getDatabaseTime(database.db),
    oidc: { provider, authenticate: await createAuthenticate(database.db), db: database.db, notifier, cookieKeys: COOKIE_KEYS, ui, limiter, audit: loginAudit, passkeys },
    manage: { issuer, cookieKeys: COOKIE_KEYS, ui, organisation: 'Example Inc.', timeZone: 'Europe/Berlin' },
    accountArea,
    account: {
      db: database.db,
      sendPasswordResetCode,
      codeSecrets: deriveCodeSecrets(COOKIE_KEYS),
      notifier,
      selfServiceActivation,
      activationValidityMs,
      cookieKeys: COOKIE_KEYS,
      secure: issuer.startsWith('https:'),
      issuer,
      ui,
      limiter,
      audit: loginAudit,
      background,
      clientLogouts,
      passkeys,
    },
    admin: {
      db: database.db,
      provider,
      notifier,
      sendPasswordResetCode,
      limiter,
      allowPrivateAddresses,
      activationValidityMs,
      clientLogouts,
      codeSecrets: deriveCodeSecrets(COOKIE_KEYS),
    },
  })
  await app.ready()
  registerCodeSource(app, lastCode)

  const tokenFor = async (clientId: string, scope: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { authorization: basicAuth(clientId, 'dev-secret'), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'client_credentials', scope }).toString(),
    })
    expect(response.statusCode, response.body).toBe(200)
    return response.json().access_token as string
  }

  /**
   * Signs a person in to the administration UI (password, then the code) and returns the access token the UI would
   * get, the way an application does it: authorization code flow with PKCE.
   */
  const personToken = async (email = 'admin@example.com', { clientId = ADMIN_UI_CLIENT_ID, redirectUri = `${issuer}/manage/callback` } = {}) => {
    const browser = new Browser(app)
    const result = await signIn(browser, { clientId, redirectUri, email })
    expect(result.code, 'the sign-in should end with an authorization code').toBeTruthy()
    const response = await browser.request('POST', '/token', {
      form: { grant_type: 'authorization_code', code: result.code!, redirect_uri: redirectUri, client_id: clientId, code_verifier: result.verifier },
    })
    expect(response.statusCode, response.body).toBe(200)
    return response.json().access_token as string
  }

  const adminToken = await tokenFor('demo-admin', 'admin')
  const directoryToken = await tokenFor('demo-import', 'directory')

  const api = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    { token = adminToken, body }: { token?: string | null; body?: unknown } = {},
  ) =>
    app.inject({
      method,
      url: `/admin${url}`,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'user-agent': 'admin-test/1.0',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      payload: body === undefined ? undefined : JSON.stringify(body),
    })

  const count = async (table: string, where = 'true') =>
    Number((await database.pool.query(`select count(*) from ${table} where ${where}`)).rows[0].count)

  const audit = async (action: string, targetId: string) =>
    (await database.pool.query(`select * from audit_events where action = $1 and target_id = $2 order by created_at`, [action, targetId])).rows

  return {
    app,
    database,
    provider,
    notifier,
    notifications,
    lastResetCode,
    lastPhoneCode,
    api,
    tokenFor,
    adminToken,
    directoryToken,
    personToken,
    count,
    audit,
    loginAudit,
    limiter,
    /** Waits until the work that goes on after responses (the password reset mail) is done. */
    settle: () => background.idle(),
    backgroundErrors,
    logoutFailures,
    /** What is asked of a device for a passkey, and how its answer is checked. */
    passkeys,
    /** What the account pages are built with, for a test that builds them once more to look at their routes. */
    accountArea,
    close: async () => {
      await background.idle()
      await app.close()
      await database.drop()
    },
  }
}

export type AdminHarness = Awaited<ReturnType<typeof createAdminHarness>>
