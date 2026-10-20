import { createOidcPayloadStore, listClaimTypes } from '@progwise/pforte-db/oidc'
import type { Database } from '@progwise/pforte-db'
import { verify } from '@node-rs/argon2'
import Provider, { type Configuration, type JWK } from 'oidc-provider'
import type { Config } from '../config.js'
import { parseAcceptLanguage } from '../i18n/index.js'
import { createUi, type Ui } from '../ui/index.js'
import { ACR_PASSWORD, ACR_SECOND_FACTOR } from '../auth/assurance.js'
import { createFindAccount, standardClaims } from './accounts.js'
import { ClientAdapter, PayloadAdapter } from './adapter.js'

export interface ProviderOptions {
  config: Pick<Config, 'issuer' | 'cookieKeys' | 'jwks'> & Partial<Pick<Config, 'allowPrivateAddresses'>>
  db: Database
  /** Called with unexpected errors raised while handling a request. */
  onError?: (error: Error) => void
  /** The pages and languages for error pages. Defaults to the built-in ones. */
  ui?: Ui
}

/**
 * Every client is registered by an administrator and is first-party, so there is no consent
 * screen: the grant covers whatever scopes the client asks for. It is created on the first
 * login and extended when the same signed-in browser later asks for more scopes. Without the
 * extension the library would ask for consent, which has no page here.
 */
const grantRequestedScopes: Configuration['loadExistingGrant'] = async (ctx) => {
  const { client, session } = ctx.oidc
  if (!client || !session?.accountId) {
    return undefined
  }

  const grantId = ctx.oidc.result?.consent?.grantId || session.grantIdFor(client.clientId)
  const grant =
    (grantId && (await ctx.oidc.provider.Grant.find(grantId))) ||
    new ctx.oidc.provider.Grant({ clientId: client.clientId, accountId: session.accountId })

  grant.addOIDCScope(String(ctx.oidc.params?.scope ?? 'openid'))
  await grant.save()
  return grant
}

/**
 * Builds a provider. The library fixes its list of known claims at construction, so claim types
 * are read from the database here and the provider is rebuilt when they change (see
 * `createProviderHolder`).
 */
export const createProvider = async ({ config, db, onError, ui = createUi() }: ProviderOptions) => {
  const claimTypeKeys = (await listClaimTypes(db)).map((claimType) => claimType.key)
  const store = createOidcPayloadStore(db)
  const secureIssuer = config.issuer.startsWith('https:')
  /** The pages in the language of the browser, for what the library renders. */
  const viewFor = (ctx: { get(name: string): string }) => ui.pages.for(ui.i18n.pick(parseAcceptLanguage(ctx.get('accept-language'))))

  const provider = new Provider(config.issuer, {
    adapter: (name: string) => (name === 'Client' ? new ClientAdapter(db) : new PayloadAdapter(name, store)),
    cookies: { keys: config.cookieKeys, ...(secureIssuer && { long: { sameSite: 'none' as const } }) },
    jwks: { keys: config.jwks.keys as unknown as JWK[] },
    claims: {
      // `acr` and `amr` tell the application whether a second factor was used, so they are always
      // part of the ID token; the library leaves them out unless they are requested.
      openid: [...standardClaims.openid, 'acr', 'amr', ...claimTypeKeys],
      email: [...standardClaims.email],
      profile: [...standardClaims.profile],
      phone: [...standardClaims.phone],
    },
    acrValues: [ACR_PASSWORD, ACR_SECOND_FACTOR],
    // The sign-in pages follow `ui_locales`, so applications can see which languages exist.
    discovery: { ui_locales_supported: ui.i18n.languages },
    findAccount: createFindAccount(db),
    responseTypes: ['code'],
    // OpenID Connect Core requires the authorization endpoint to accept POST as well as GET. A
    // POST comes from the application's site, so the session cookie must be sent cross-site:
    // SameSite=None, which browsers only accept together with Secure. That means https; for the
    // http issuer of local development POST stays off.
    enableHttpPostMethods: secureIssuer,
    // The library refuses to call loopback and private addresses (SSRF protection) by handing
    // its fetch a guarded dispatcher. Where the administrator allows it, call without the guard.
    ...(config.allowPrivateAddresses && {
      fetch: (input: string | URL | Request, init?: RequestInit & { dispatcher?: unknown }) => {
        const { dispatcher: _guard, ...options } = init ?? {}
        return fetch(input, options)
      },
    }),
    // Integrators read claims straight from the ID token, so it carries all claims for the
    // granted scopes instead of leaving them to the userinfo endpoint.
    conformIdTokenClaims: false,
    renderError: async (ctx, out, error) => {
      onError?.(error)
      ctx.type = 'html'
      const view = viewFor(ctx)
      ctx.set('Content-Security-Policy', ui.pages.contentSecurityPolicy)
      // The library's own description is in English; the title and the fallback follow the browser's language.
      ctx.body = view.notice(view.t('error.title'), out.error_description ?? out.error ?? view.t('error.generic'))
    },
    // The library only supports S256 (plain was removed). PKCE is required unless an administrator
    // switched it off for a confidential client (clients.pkce_required); public clients always need it.
    // When a client sends a challenge anyway, the library verifies it.
    extraClientMetadata: { properties: ['pkce_required'] },
    pkce: {
      required: (_ctx, client) => client.clientAuthMethod === 'none' || client.metadata().pkce_required !== false,
    },
    // `admin` and `directory` are the scopes of the admin API. Only clients registered with them
    // can ask for them (clients.scopes), and only through the client_credentials grant.
    scopes: ['openid', 'offline_access', 'admin', 'directory'],
    features: {
      clientCredentials: { enabled: true },
      devInteractions: { enabled: false },
      rpInitiatedLogout: {
        enabled: true,
        // The library's own pages load fonts from a font service and look like nothing else here. These are
        // pforte's: in the language of the browser, in the look of the installation, with nothing from outside.
        logoutSource: async (ctx, form) => {
          const view = viewFor(ctx)
          ctx.type = 'html'
          ctx.set('Content-Security-Policy', ui.pages.contentSecurityPolicy)
          ctx.body = view.logoutConfirm({ host: ctx.host, formHtml: form })
        },
        postLogoutSuccessSource: async (ctx) => {
          const view = viewFor(ctx)
          ctx.type = 'html'
          ctx.set('Content-Security-Policy', ui.pages.contentSecurityPolicy)
          ctx.body = view.notice(view.t('logout.doneTitle'), view.t('logout.done'))
        },
      },
      backchannelLogout: { enabled: true },
    },
    // A phone stays signed in: refresh tokens go to every client that may use them and
    // outlive the browser session. They rotate on every use; reuse revokes the grant.
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    expiresWithSession: async () => false,
    rotateRefreshToken: () => true,
    loadExistingGrant: grantRequestedScopes,
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
  })

  provider.on('server_error', (_ctx, error) => onError?.(error))

  // Because `expiresWithSession` is false, the library marks every authorization as surviving
  // logout and leaves its tokens alone. We want the opposite: signing out revokes the refresh
  // tokens of that browser session (and only that one: other devices have their own grants).
  // Clearing the flag lets the library's own logout revoke the grants. This relies on the
  // library's session internals, so the flow tests cover it; recheck them on upgrades.
  provider.on('authorization.success', (ctx) => {
    const clientId = ctx.oidc.client?.clientId
    const session = ctx.oidc.session as unknown as
      | { authorizationFor(clientId: string): { persistsLogout?: boolean } }
      | undefined
    if (clientId && session) {
      session.authorizationFor(clientId).persistsLogout = false
    }
  })

  // The provider derives its URLs from X-Forwarded-Proto / Host. Both are set from the issuer
  // by the route handler (see routes.ts), so trusting them is safe.
  provider.proxy = true

  // Client secrets are stored as argon2 hashes, but the library compares plain values.
  // For confidential clients the "secret" it holds is the hash.
  provider.Client.prototype.compareClientSecret = async function compareClientSecret(actual: string) {
    try {
      return await verify(this.clientSecret as string, actual)
    } catch {
      return false
    }
  }

  return provider
}

/**
 * Holds the current provider so it can be replaced without restarting the server, e.g. after
 * claim types changed. Sessions and tokens live in Postgres, so nobody is signed out.
 */
export const createProviderHolder = async (options: ProviderOptions) => {
  let provider = await createProvider(options)
  let callback = provider.callback()

  return {
    issuer: options.config.issuer,
    current: () => provider,
    handle: (...args: Parameters<typeof callback>) => callback(...args),
    reload: async () => {
      provider = await createProvider(options)
      callback = provider.callback()
    },
  }
}

export type ProviderHolder = Awaited<ReturnType<typeof createProviderHolder>>
