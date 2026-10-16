import { findClientById } from '@progwise/pforte-db/oidc'
import type { createOidcPayloadStore } from '@progwise/pforte-db/oidc'
import type { Database } from '@progwise/pforte-db'
import type { Adapter, AdapterPayload } from 'oidc-provider'

/** Numeric model types stored in oidc_payloads.type. Append only; never renumber. */
const modelTypes: Record<string, number> = {
  Session: 1,
  AccessToken: 2,
  AuthorizationCode: 3,
  RefreshToken: 4,
  DeviceCode: 5,
  ClientCredentials: 6,
  Client: 7,
  InitialAccessToken: 8,
  RegistrationAccessToken: 9,
  Interaction: 10,
  ReplayDetection: 11,
  PushedAuthorizationRequest: 12,
  Grant: 13,
  BackchannelAuthenticationRequest: 14,
}

type PayloadStore = ReturnType<typeof createOidcPayloadStore>

/** Stores sessions, grants, tokens and interactions in Postgres. */
export class PayloadAdapter implements Adapter {
  readonly #type: number

  constructor(
    name: string,
    private readonly store: PayloadStore,
  ) {
    const type = modelTypes[name]
    if (type === undefined) {
      throw new Error(`Unknown OIDC model "${name}"`)
    }
    this.#type = type
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn: number) {
    await this.store.upsert(id, this.#type, payload, expiresIn)
  }

  async find(id: string) {
    return this.store.find(id, this.#type) as Promise<AdapterPayload | undefined>
  }

  async findByUid(uid: string) {
    return this.store.findByUid(uid, this.#type) as Promise<AdapterPayload | undefined>
  }

  async findByUserCode(userCode: string) {
    return this.store.findByUserCode(userCode, this.#type) as Promise<AdapterPayload | undefined>
  }

  async consume(id: string) {
    await this.store.consume(id, this.#type)
  }

  async destroy(id: string) {
    await this.store.destroy(id, this.#type)
  }

  async revokeByGrantId(grantId: string) {
    await this.store.revokeByGrantId(grantId)
  }
}

/**
 * Serves clients from the `clients` table. Clients are managed by administrators, never by
 * the provider, so every write is refused.
 */
export class ClientAdapter implements Adapter {
  constructor(private readonly db: Database) {}

  async find(id: string): Promise<AdapterPayload | undefined> {
    const client = await findClientById(this.db, id)
    if (!client) return undefined

    const confidential = client.type === 'confidential'
    const metadata: AdapterPayload = {
      client_id: client.clientId,
      client_name: client.name,
      application_type: 'web',
      redirect_uris: client.redirectUris,
      post_logout_redirect_uris: client.postLogoutRedirectUris,
      grant_types: client.allowedGrants,
      scope: client.scopes.join(' '),
      // Machine clients (client_credentials only) never go through the authorization endpoint.
      response_types: client.allowedGrants.includes('authorization_code') ? ['code'] : [],
      pkce_required: client.type === 'public' || client.pkceRequired,
      token_endpoint_auth_method: confidential ? 'client_secret_basic' : 'none',
      // The stored value is an argon2 hash; compareClientSecret is overridden to verify against it.
      ...(confidential && client.secretHash ? { client_secret: client.secretHash } : {}),
      ...(client.backchannelLogoutUri
        ? {
            backchannel_logout_uri: client.backchannelLogoutUri,
            backchannel_logout_session_required: client.backchannelLogoutSessionRequired,
          }
        : {}),
    }
    return metadata
  }

  async upsert(): Promise<void> {
    throw new Error('Clients are managed through the admin API, not by the provider')
  }

  async findByUid(): Promise<undefined> {
    return undefined
  }

  async findByUserCode(): Promise<undefined> {
    return undefined
  }

  async consume(): Promise<void> {}

  async destroy(): Promise<void> {
    throw new Error('Clients are managed through the admin API, not by the provider')
  }

  async revokeByGrantId(): Promise<void> {}
}
