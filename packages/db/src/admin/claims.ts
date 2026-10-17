import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { type DatabaseOrTransaction, recordAuditEvent } from '../audit.js'
import { claimTypes, clientClaimTypes, clients, userClaims } from '../schema/index.js'
import type { RequestContext } from './users.js'

/** Claim values by claim type, e.g. `{ partner_no: ['00892', '00893'] }`. */
export type ClaimValues = Record<string, string[]>

type ClaimTypeRow = typeof claimTypes.$inferSelect

import { AdminError, type Problem } from './errors.js'

export type ClaimProblem = Problem

/** Thrown when claim values or claim types cannot be applied. */
export class ClaimsError extends AdminError {}

/** Names that tokens already use for something else. A claim type may not shadow them. */
export const RESERVED_CLAIM_NAMES = new Set([
  'sub', 'iss', 'aud', 'exp', 'iat', 'nbf', 'jti', 'nonce', 'auth_time', 'acr', 'amr', 'azp', 'sid',
  'at_hash', 'c_hash', 's_hash', 'scope', 'client_id', 'cnf',
  'name', 'given_name', 'family_name', 'middle_name', 'nickname', 'preferred_username', 'profile',
  'picture', 'website', 'email', 'email_verified', 'gender', 'birthdate', 'zoneinfo', 'locale',
  'phone_number', 'phone_number_verified', 'address', 'updated_at',
])

export const getClaimType = async (db: DatabaseOrTransaction, key: string) => {
  const [claimType] = await db.select().from(claimTypes).where(eq(claimTypes.key, key))
  return claimType
}

export const getUserClaims = async (db: DatabaseOrTransaction, userId: string): Promise<ClaimValues> => {
  const rows = await db
    .select({ type: userClaims.claimTypeKey, value: userClaims.value })
    .from(userClaims)
    .where(eq(userClaims.userId, userId))
    .orderBy(asc(userClaims.claimTypeKey), asc(userClaims.value))
  const claims: ClaimValues = {}
  for (const { type, value } of rows) (claims[type] ??= []).push(value)
  return claims
}

const matches = (pattern: string | null, value: string) => pattern === null || new RegExp(pattern).test(value)

/** Checks wanted values against the claim types and reports every problem, not just the first. */
const validate = (wanted: ClaimValues, types: Map<string, ClaimTypeRow>) => {
  const problems: ClaimProblem[] = []
  for (const [type, values] of Object.entries(wanted)) {
    const path = `/claims/${type}`
    const claimType = types.get(type)
    if (!claimType) {
      problems.push({ path, message: `There is no claim type "${type}". Create it first.` })
      continue
    }
    if (!claimType.multiValued && values.length > 1) {
      problems.push({ path, message: `"${type}" holds a single value, but ${values.length} were given.` })
    }
    for (const value of values) {
      if (value.length === 0 || value.length > 200) {
        problems.push({ path, message: 'Values must be 1 to 200 characters long.' })
      } else if (!matches(claimType.valuePattern, value)) {
        problems.push({ path, message: `"${value}" does not match the pattern ${claimType.valuePattern} of "${type}".` })
      }
    }
  }
  return problems
}

const clean = (wanted: ClaimValues): ClaimValues =>
  Object.fromEntries(Object.entries(wanted).map(([type, values]) => [type, [...new Set(values.map((value) => value.trim()))]]))

/**
 * Replaces the user's values of the given claim types. Types that are not mentioned are left
 * alone; an empty list removes every value of a type. Only differences are written, and an event
 * is recorded only when something changed. Throws `ClaimsError` with all problems if anything is
 * invalid, before writing.
 */
export const setUserClaims = async (
  tx: DatabaseOrTransaction,
  context: RequestContext,
  user: { id: string; email: string },
  requested: ClaimValues,
  action = 'user.claims.set',
) => {
  const wanted = clean(requested)
  const typeKeys = Object.keys(wanted)
  const types = new Map(
    typeKeys.length === 0
      ? []
      : (await tx.select().from(claimTypes).where(inArray(claimTypes.key, typeKeys))).map((row) => [row.key, row]),
  )
  const problems = validate(wanted, types)
  if (problems.length > 0) {
    throw new ClaimsError('The claims are not valid.', 'invalid', problems)
  }

  const current = await getUserClaims(tx, user.id)
  const changes: Record<string, { from: string[]; to: string[] }> = {}
  for (const [type, values] of Object.entries(wanted)) {
    const before = current[type] ?? []
    const toRemove = before.filter((value) => !values.includes(value))
    const toAdd = values.filter((value) => !before.includes(value))
    if (toRemove.length === 0 && toAdd.length === 0) continue

    if (toRemove.length > 0) {
      await tx
        .delete(userClaims)
        .where(and(eq(userClaims.userId, user.id), eq(userClaims.claimTypeKey, type), inArray(userClaims.value, toRemove)))
    }
    if (toAdd.length > 0) {
      await tx.insert(userClaims).values(toAdd.map((value) => ({ userId: user.id, claimTypeKey: type, value })))
    }
    changes[type] = { from: before, to: [...values].sort() }
  }

  const changed = Object.keys(changes).length > 0
  if (changed) {
    await recordAuditEvent(tx, {
      actor: context.actor,
      ip: context.ip,
      userAgent: context.userAgent,
      action,
      target: { type: 'user', id: user.id },
      details: { email: user.email, changes },
    })
  }
  return { changed, changes, claims: await getUserClaims(tx, user.id) }
}

/** Adds one value. Valid for single-valued types only while the user holds no other value. */
export const addUserClaim = async (
  tx: DatabaseOrTransaction,
  context: RequestContext,
  user: { id: string; email: string },
  type: string,
  value: string,
) => {
  const claimType = await getClaimType(tx, type)
  if (!claimType) {
    throw new ClaimsError('The claims are not valid.', 'invalid', [{ path: `/claims/${type}`, message: `There is no claim type "${type}". Create it first.` }])
  }
  const existing = (await getUserClaims(tx, user.id))[type] ?? []
  if (!claimType.multiValued && existing.length > 0 && !existing.includes(value.trim())) {
    throw new ClaimsError(`"${type}" holds a single value and the user already has one. Set it instead of adding.`, 'conflict')
  }
  return setUserClaims(tx, context, user, { [type]: [...existing, value] }, 'user.claims.add')
}

export const removeUserClaim = async (
  tx: DatabaseOrTransaction,
  context: RequestContext,
  user: { id: string; email: string },
  type: string,
  value: string,
) => {
  const existing = (await getUserClaims(tx, user.id))[type] ?? []
  const remaining = existing.filter((held) => held !== value)
  if (remaining.length === existing.length) return { changed: false, changes: {}, claims: await getUserClaims(tx, user.id) }
  return setUserClaims(tx, context, user, { [type]: remaining }, 'user.claims.remove')
}

// --- claim types ---------------------------------------------------------------------------

export interface ClaimTypeInput {
  key: string
  description?: string
  valuePattern?: string | null
  multiValued?: boolean
}

export const listClaimTypesWithClients = async (db: DatabaseOrTransaction) => {
  const types = await db.select().from(claimTypes).orderBy(asc(claimTypes.key))
  const assignments = await db.select().from(clientClaimTypes)
  return types.map((type) => ({
    ...type,
    clients: assignments.filter((row) => row.claimTypeKey === type.key).map((row) => row.clientId).sort(),
  }))
}

const audit = (context: RequestContext, action: string, key: string, details: Record<string, unknown>) => ({
  actor: context.actor,
  ip: context.ip,
  userAgent: context.userAgent,
  action,
  target: { type: 'claim_type', id: key },
  details,
})

export const isValidPattern = (pattern: string) => {
  try {
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}

export const createClaimType = async (tx: DatabaseOrTransaction, context: RequestContext, input: ClaimTypeInput) => {
  if (RESERVED_CLAIM_NAMES.has(input.key)) {
    throw new ClaimsError('This name is reserved.', 'invalid', [{ path: '/key', message: `"${input.key}" is already used in tokens and cannot be a claim type.` }])
  }
  const [created] = await tx.insert(claimTypes).values(input).returning()
  await recordAuditEvent(tx, audit(context, 'claim_type.create', input.key, { ...input }))
  return created!
}

/** Counts the users who hold a value of the type, and how many values that is. */
export const claimTypeUsage = async (db: DatabaseOrTransaction, key: string) => {
  const [usage] = await db
    .select({ users: sql<number>`count(distinct ${userClaims.userId})::int`, values: sql<number>`count(*)::int` })
    .from(userClaims)
    .where(eq(userClaims.claimTypeKey, key))
  return usage!
}

export const updateClaimType = async (
  tx: DatabaseOrTransaction,
  context: RequestContext,
  claimType: ClaimTypeRow,
  wanted: Partial<Omit<ClaimTypeInput, 'key'>>,
) => {
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const field of ['description', 'valuePattern', 'multiValued'] as const) {
    const to = wanted[field]
    if (to !== undefined && to !== claimType[field]) changes[field] = { from: claimType[field], to }
  }
  if (Object.keys(changes).length === 0) return { claimType, changed: false as const }

  // Refuse a change that existing values would violate, and say how many do.
  const held = await tx.select({ userId: userClaims.userId, value: userClaims.value }).from(userClaims).where(eq(userClaims.claimTypeKey, claimType.key))
  if (changes.valuePattern && wanted.valuePattern) {
    const wrong = held.filter((row) => !matches(wanted.valuePattern ?? null, row.value))
    if (wrong.length > 0) {
      throw new ClaimsError(`${wrong.length} existing value(s) do not match the new pattern.`, 'conflict')
    }
  }
  if (changes.multiValued && wanted.multiValued === false) {
    const perUser = new Map<string, number>()
    for (const row of held) perUser.set(row.userId, (perUser.get(row.userId) ?? 0) + 1)
    const several = [...perUser.values()].filter((count) => count > 1).length
    if (several > 0) {
      throw new ClaimsError(`${several} user(s) hold several values, so the type cannot become single-valued.`, 'conflict')
    }
  }

  const values = Object.fromEntries(Object.entries(changes).map(([field, { to }]) => [field, to]))
  const [updated] = await tx.update(claimTypes).set(values).where(eq(claimTypes.key, claimType.key)).returning()
  await recordAuditEvent(tx, audit(context, 'claim_type.update', claimType.key, { changes }))
  return { claimType: updated!, changed: true as const }
}

/**
 * Deletes a claim type. Refused while users hold values, unless `force` is set; then the values
 * go too, and the audit event records how many.
 */
export const deleteClaimType = async (
  tx: DatabaseOrTransaction,
  context: RequestContext,
  claimType: ClaimTypeRow,
  { force }: { force: boolean },
) => {
  const usage = await claimTypeUsage(tx, claimType.key)
  if (usage.values > 0 && !force) {
    throw new ClaimsError(
      `${usage.users} user(s) hold ${usage.values} value(s) of "${claimType.key}". Remove them first, or delete with force=true.`,
      'conflict',
    )
  }
  if (usage.values > 0) {
    await tx.delete(userClaims).where(eq(userClaims.claimTypeKey, claimType.key))
  }
  await tx.delete(claimTypes).where(eq(claimTypes.key, claimType.key))
  await recordAuditEvent(
    tx,
    audit(context, 'claim_type.delete', claimType.key, {
      description: claimType.description,
      multiValued: claimType.multiValued,
      forced: force,
      usersAffected: usage.users,
      valuesDeleted: usage.values,
    }),
  )
}

/** Which claim types a client receives. Replaces the whole set. */
export const setClientClaimTypes = async (
  tx: DatabaseOrTransaction,
  context: RequestContext,
  clientId: string,
  wanted: string[],
) => {
  const [client] = await tx.select({ clientId: clients.clientId }).from(clients).where(eq(clients.clientId, clientId))
  if (!client) throw new ClaimsError('There is no such client.', 'not_found')

  const keys = [...new Set(wanted)]
  const known = keys.length === 0 ? [] : await tx.select({ key: claimTypes.key }).from(claimTypes).where(inArray(claimTypes.key, keys))
  const unknown = keys.filter((key) => !known.some((row) => row.key === key))
  if (unknown.length > 0) {
    throw new ClaimsError('Unknown claim types.', 'invalid', unknown.map((key) => ({ path: '/claimTypes', message: `There is no claim type "${key}".` })))
  }

  const before = (await getClientClaimTypes(tx, clientId)).sort()
  const after = [...keys].sort()
  const added = after.filter((key) => !before.includes(key))
  const removed = before.filter((key) => !after.includes(key))
  if (added.length === 0 && removed.length === 0) return { changed: false, claimTypes: before }

  if (removed.length > 0) {
    await tx.delete(clientClaimTypes).where(and(eq(clientClaimTypes.clientId, clientId), inArray(clientClaimTypes.claimTypeKey, removed)))
  }
  if (added.length > 0) {
    await tx.insert(clientClaimTypes).values(added.map((claimTypeKey) => ({ clientId, claimTypeKey })))
  }
  await recordAuditEvent(tx, {
    actor: context.actor,
    ip: context.ip,
    userAgent: context.userAgent,
    action: 'client.claim_types.set',
    target: { type: 'client', id: clientId },
    details: { from: before, to: after },
  })
  return { changed: true, claimTypes: after }
}

export const getClientClaimTypes = async (db: DatabaseOrTransaction, clientId: string) =>
  (await db.select({ key: clientClaimTypes.claimTypeKey }).from(clientClaimTypes).where(eq(clientClaimTypes.clientId, clientId))).map((row) => row.key)
