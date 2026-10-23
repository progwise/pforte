import { asc, eq, sql } from 'drizzle-orm'
import { type DatabaseOrTransaction, recordAuditEvent } from '../audit.js'
import { clientClaimTypes, clients, oidcPayloads } from '../schema/index.js'
import { AdminError, type Problem } from './errors.js'
import type { RequestContext } from './users.js'

type ClientRow = typeof clients.$inferSelect

/** What an administrator can set on a client. */
export interface ClientConfig {
  name: string
  type: 'public' | 'confidential'
  /** Where the application starts; pages that end a flow in pforte lead there. */
  clientUri: string | null
  redirectUris: string[]
  postLogoutRedirectUris: string[]
  backchannelLogoutUri: string | null
  backchannelLogoutSessionRequired: boolean
  allowedGrants: string[]
  scopes: string[]
  pkceRequired: boolean
}

/** Scopes an application may be given. */
export const APPLICATION_SCOPES = ['openid', 'offline_access', 'profile', 'email', 'phone'] as const
/** Scopes of the admin API, for machine clients only. */
export const ADMIN_SCOPES = ['admin', 'directory'] as const
export const APPLICATION_GRANTS = ['authorization_code', 'refresh_token'] as const

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** https, or http for the loopback address during development. No wildcards, no fragments. */
export const isAllowedUri = (value: string) => {
  try {
    const url = new URL(value)
    if (url.hash || value.includes('*')) return false
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))
  } catch {
    return false
  }
}

const subsetOf = (values: string[], allowed: readonly string[]) => values.every((value) => allowed.includes(value))

/**
 * The rules that keep clients coherent. Two kinds exist and never mix:
 * - an application (authorization code flow, public or confidential) with OpenID scopes, or
 * - a machine (client_credentials, confidential) with admin scopes, for the admin API.
 * Returns every problem, so a form can show them all at once.
 */
export const validateClientConfig = (config: ClientConfig): Problem[] => {
  const problems: Problem[] = []
  const add = (path: string, message: string) => problems.push({ path, message })
  const machine = config.allowedGrants.includes('client_credentials')

  config.redirectUris.forEach((uri, index) => {
    if (!isAllowedUri(uri)) add(`/redirectUris/${index}`, `"${uri}" must be an https URL (http only for localhost) without wildcards or fragment.`)
  })
  config.postLogoutRedirectUris.forEach((uri, index) => {
    if (!isAllowedUri(uri)) add(`/postLogoutRedirectUris/${index}`, `"${uri}" must be an https URL (http only for localhost) without wildcards or fragment.`)
  })
  if (config.clientUri && !isAllowedUri(config.clientUri)) {
    add('/clientUri', 'The start address must be an https URL (http only for localhost) without wildcards or fragment.')
  }
  if (config.backchannelLogoutUri && !isAllowedUri(config.backchannelLogoutUri)) {
    add('/backchannelLogoutUri', 'Logout tokens are sent here, so it must be an https URL (http only for localhost).')
  }
  if (config.pkceRequired === false && config.type === 'public') {
    add('/pkceRequired', 'Public clients always require PKCE.')
  }

  if (machine) {
    if (config.type !== 'confidential') add('/type', 'A client with the client_credentials grant must be confidential.')
    if (config.allowedGrants.length !== 1) add('/allowedGrants', 'A machine client has only the client_credentials grant.')
    if (config.scopes.length === 0 || !subsetOf(config.scopes, ADMIN_SCOPES)) {
      add('/scopes', `A machine client needs at least one of ${ADMIN_SCOPES.join(', ')} and nothing else.`)
    }
    if (config.redirectUris.length > 0 || config.postLogoutRedirectUris.length > 0 || config.backchannelLogoutUri || config.clientUri) {
      add('/redirectUris', 'A machine client does not sign users in, so it has no redirect or logout URIs.')
    }
    return problems
  }

  if (config.allowedGrants.length === 0 || !subsetOf(config.allowedGrants, APPLICATION_GRANTS) || !config.allowedGrants.includes('authorization_code')) {
    add('/allowedGrants', `An application needs authorization_code and may add refresh_token; no other grants.`)
  }
  if (!subsetOf(config.scopes, APPLICATION_SCOPES) || !config.scopes.includes('openid')) {
    add('/scopes', `An application needs openid and may add ${APPLICATION_SCOPES.filter((scope) => scope !== 'openid').join(', ')}; admin scopes are for machine clients only.`)
  }
  if (config.redirectUris.length === 0) add('/redirectUris', 'An application needs at least one redirect URI.')
  return problems
}

export const listClients = async (db: DatabaseOrTransaction) => {
  const rows = await db.select().from(clients).orderBy(asc(clients.clientId))
  const assignments = await db.select().from(clientClaimTypes)
  return rows.map((client) => ({
    ...client,
    claimTypes: assignments.filter((row) => row.clientId === client.clientId).map((row) => row.claimTypeKey).sort(),
  }))
}

export const getClient = async (db: DatabaseOrTransaction, clientId: string) => {
  const [client] = await db.select().from(clients).where(eq(clients.clientId, clientId))
  return client
}

/** Refuses to change a client that pforte registered itself. */
const assertEditable = (client: ClientRow) => {
  if (client.system) throw new AdminError(`"${client.clientId}" is a built-in client of pforte and cannot be changed or deleted.`, 'conflict')
}

/**
 * Makes sure a built-in public client exists with these settings, and keeps it that way: it is written at every
 * start, so a changed address in the configuration takes effect and nothing done to the row survives. Writes no
 * audit event: it is pforte's own setup, not somebody's decision.
 */
export const ensureSystemClient = async (
  db: DatabaseOrTransaction,
  client: { clientId: string; name: string; redirectUris: string[]; postLogoutRedirectUris: string[]; scopes: string[] },
) => {
  const values = {
    name: client.name,
    type: 'public' as const,
    clientUri: null,
    secretHash: null,
    pkceRequired: true,
    redirectUris: client.redirectUris,
    postLogoutRedirectUris: client.postLogoutRedirectUris,
    backchannelLogoutUri: null,
    backchannelLogoutSessionRequired: false,
    allowedGrants: ['authorization_code'],
    scopes: client.scopes,
    system: true,
  }
  const problems = validateClientConfig(values)
  if (problems.length > 0) throw new AdminError('The built-in client is not valid.', 'invalid', problems)
  await db.insert(clients).values({ clientId: client.clientId, ...values }).onConflictDoUpdate({ target: clients.clientId, set: values })
}

const configOf = (client: ClientRow): ClientConfig => ({
  name: client.name,
  type: client.type,
  clientUri: client.clientUri,
  redirectUris: client.redirectUris,
  postLogoutRedirectUris: client.postLogoutRedirectUris,
  backchannelLogoutUri: client.backchannelLogoutUri,
  backchannelLogoutSessionRequired: client.backchannelLogoutSessionRequired,
  allowedGrants: client.allowedGrants,
  scopes: client.scopes,
  pkceRequired: client.pkceRequired,
})

const audit = (context: RequestContext, action: string, clientId: string, details: Record<string, unknown>) => ({
  actor: context.actor,
  ip: context.ip,
  userAgent: context.userAgent,
  action,
  target: { type: 'client', id: clientId },
  details,
})

const holdsAdminScope = (config: Pick<ClientConfig, 'scopes'>) => config.scopes.includes('admin')

/** Another client must keep the `admin` scope, or nobody could use the admin API any more. */
const assertAnotherAdminClient = async (tx: DatabaseOrTransaction, clientId: string) => {
  const [row] = await tx
    .select({ others: sql<number>`count(*)::int` })
    .from(clients)
    .where(sql`${clients.clientId} <> ${clientId} and 'admin' = any(${clients.scopes})`)
  if (row?.others === 0) {
    throw new AdminError('This is the last client with the admin scope; without it nobody could use the admin API.', 'conflict')
  }
}

/** Creates a client. A confidential client needs the hash of its secret; the caller shows the secret once. */
export const createClient = async (
  tx: DatabaseOrTransaction,
  context: RequestContext,
  input: { clientId: string; secretHash?: string } & ClientConfig,
) => {
  const problems = validateClientConfig(input)
  if (problems.length > 0) throw new AdminError('The client is not valid.', 'invalid', problems)

  const { secretHash, ...values } = input
  const [created] = await tx.insert(clients).values({ ...values, secretHash }).returning()
  await recordAuditEvent(
    tx,
    audit(context, 'client.create', input.clientId, { name: input.name, type: input.type, allowedGrants: input.allowedGrants, scopes: input.scopes }),
  )
  return created!
}

/** Applies a change. The result as a whole must still be a valid client. Writes nothing when nothing differs. */
export const updateClient = async (
  tx: DatabaseOrTransaction,
  context: RequestContext,
  client: ClientRow,
  wanted: Partial<Omit<ClientConfig, 'type'>>,
) => {
  assertEditable(client)
  const current = configOf(client)
  const next = { ...current, ...wanted }
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const field of Object.keys(wanted) as (keyof ClientConfig)[]) {
    if (JSON.stringify(current[field]) !== JSON.stringify(next[field])) changes[field] = { from: current[field], to: next[field] }
  }
  if (Object.keys(changes).length === 0) return { client, changed: false as const }

  const problems = validateClientConfig(next)
  if (problems.length > 0) throw new AdminError('The client is not valid.', 'invalid', problems)
  if (holdsAdminScope(current) && !holdsAdminScope(next)) await assertAnotherAdminClient(tx, client.clientId)

  const values = Object.fromEntries(Object.entries(changes).map(([field, { to }]) => [field, to]))
  const [updated] = await tx.update(clients).set(values).where(eq(clients.clientId, client.clientId)).returning()
  await recordAuditEvent(tx, audit(context, 'client.update', client.clientId, { changes }))
  return { client: updated!, changed: true as const }
}

/** Replaces the secret. The old one stops working at once; the new one is shown by the caller once. */
export const rotateClientSecret = async (tx: DatabaseOrTransaction, context: RequestContext, client: ClientRow, secretHash: string) => {
  assertEditable(client)
  if (client.type !== 'confidential') {
    throw new AdminError('A public client has no secret.', 'conflict')
  }
  await tx.update(clients).set({ secretHash }).where(eq(clients.clientId, client.clientId))
  await recordAuditEvent(tx, audit(context, 'client.rotate_secret', client.clientId, { name: client.name }))
}

/**
 * Deletes a client, its claim type assignments and every grant and token issued to it. Refused for
 * the last client with the admin scope, and for the client making the call.
 */
export const deleteClient = async (tx: DatabaseOrTransaction, context: RequestContext, client: ClientRow) => {
  assertEditable(client)
  if (context.actor.type === 'client' && context.actor.id === client.clientId) {
    throw new AdminError('A client cannot delete itself.', 'conflict')
  }
  if (holdsAdminScope(client)) await assertAnotherAdminClient(tx, client.clientId)

  const revoked = await tx
    .delete(oidcPayloads)
    .where(sql`${oidcPayloads.payload}->>'clientId' = ${client.clientId}`)
    .returning({ id: oidcPayloads.id })
  await recordAuditEvent(
    tx,
    audit(context, 'client.delete', client.clientId, { name: client.name, type: client.type, tokensAndGrantsRevoked: revoked.length }),
  )
  await tx.delete(clients).where(eq(clients.clientId, client.clientId))
}
