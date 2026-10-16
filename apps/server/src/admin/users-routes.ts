import type { Database } from '@progwise/pforte-db'
import {
  createUser,
  deleteUser,
  findUserByEmail,
  findUserById,
  getUserClaims,
  listUsers,
  type RequestContext,
  setUserClaims,
  updateUser,
} from '@progwise/pforte-db/admin'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { type AdminAuth, hasScope } from './auth.js'
import { answeringClaimsErrors } from './claims-errors.js'
import { claimValues } from './claims-routes.js'
import { problem, problemSchema } from './problem.js'

const USER_STATUSES = ['created', 'active', 'locked', 'deactivated'] as const

const email = z.email().transform((value) => value.trim().toLowerCase())
const phone = z.string().regex(/^\+[1-9]\d{6,14}$/, 'Use the E.164 format, e.g. +4915112345678')
const language = z.string().regex(/^[a-z]{2,3}$/, 'Use a language code such as de or en')
const name = z.string().trim().min(1).max(200)

const userSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  phone: z.string().nullable(),
  phoneVerifiedAt: z.string().nullable(),
  language: z.string(),
  status: z.enum(USER_STATUSES),
  isAdmin: z.boolean(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

type UserRow = NonNullable<Awaited<ReturnType<typeof findUserById>>>

/** The API's view of a user. Password hash, activation token and failed-login state stay inside. */
export const toUserDto = (user: UserRow): z.infer<typeof userSchema> => ({
  id: user.id,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  phone: user.phone,
  phoneVerifiedAt: user.phoneVerifiedAt?.toISOString() ?? null,
  language: user.language,
  status: user.status,
  isAdmin: user.isAdmin,
  lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  createdAt: user.createdAt.toISOString(),
  updatedAt: user.updatedAt.toISOString(),
})

const isUniqueViolation = (error: unknown): boolean => {
  const candidate = error as { code?: string; cause?: unknown } | undefined
  return candidate?.code === '23505' || (candidate?.cause !== undefined && isUniqueViolation(candidate.cause))
}

export const requestContext = (request: FastifyRequest): RequestContext => ({
  actor: { type: 'client', id: request.admin?.clientId },
  ip: request.ip,
  userAgent: request.headers['user-agent'],
})

const ERROR_RESPONSES = { 400: problemSchema, 401: problemSchema, 403: problemSchema, 404: problemSchema, 409: problemSchema }

export const usersRoutes =
  ({ db, auth }: { db: Database; auth: AdminAuth }) =>
  async (instance: FastifyInstance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>()
    const onRequest = auth.require('directory', 'admin')

    const notFound = (reply: Parameters<typeof problem>[0]) => problem(reply, 404, 'Not found', 'There is no such user.')
    const conflict = (reply: Parameters<typeof problem>[0]) =>
      problem(reply, 409, 'Conflict', 'A user with this e-mail address already exists.')
    const adminOnly = (reply: Parameters<typeof problem>[0]) =>
      problem(reply, 403, 'Forbidden', 'Only the admin scope may grant or remove administrator rights.')

    app.post(
      '/users',
      {
        onRequest,
        schema: {
          tags: ['Users'],
          summary: 'Create a user',
          body: z.object({
            email,
            firstName: name,
            lastName: name,
            phone: phone.optional(),
            language: language.optional(),
            isAdmin: z.boolean().optional(),
          }),
          response: { 201: userSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        if (request.body.isAdmin !== undefined && !hasScope(request, 'admin')) return adminOnly(reply)
        try {
          const user = await db.transaction((tx) => createUser(tx, requestContext(request), request.body))
          return reply.code(201).header('Location', `/admin/users/${user.id}`).send(toUserDto(user))
        } catch (error) {
          if (isUniqueViolation(error)) return conflict(reply)
          throw error
        }
      },
    )

    app.get(
      '/users',
      {
        onRequest,
        schema: {
          tags: ['Users'],
          summary: 'List users',
          description: 'Newest last. Pass `nextCursor` as `cursor` to get the following page.',
          querystring: z.object({
            search: z.string().trim().min(1).optional(),
            status: z.enum(USER_STATUSES).optional(),
            claim: z
              .string()
              .regex(/^[^:]+:.+$/, 'Use claim=<type>:<value>, e.g. partner_no:00892')
              .optional(),
            cursor: z.uuid().optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
          }),
          response: { 200: z.object({ items: z.array(userSchema), nextCursor: z.uuid().optional() }), ...ERROR_RESPONSES },
        },
      },
      async (request) => {
        const { search, status, claim, cursor, limit } = request.query
        const separator = claim?.indexOf(':') ?? -1
        const { items, nextCursor } = await listUsers(db, {
          search,
          status,
          claim: claim ? { type: claim.slice(0, separator), value: claim.slice(separator + 1) } : undefined,
          after: cursor,
          limit,
        })
        return { items: items.map(toUserDto), nextCursor }
      },
    )

    app.get(
      '/users/:id',
      {
        onRequest,
        schema: {
          tags: ['Users'],
          summary: 'Get a user',
          params: z.object({ id: z.uuid() }),
          response: { 200: userSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const user = await findUserById(db, request.params.id)
        return user ? toUserDto(user) : notFound(reply)
      },
    )

    app.patch(
      '/users/:id',
      {
        onRequest,
        schema: {
          tags: ['Users'],
          summary: 'Change a user',
          description: 'Only the fields given are changed. Nothing is written when nothing differs.',
          params: z.object({ id: z.uuid() }),
          body: z
            .object({
              email: email.optional(),
              firstName: name.optional(),
              lastName: name.optional(),
              phone: phone.nullable().optional(),
              language: language.optional(),
              isAdmin: z.boolean().optional(),
            })
            .refine((body) => Object.keys(body).length > 0, 'Give at least one field to change'),
          response: { 200: userSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        if (request.body.isAdmin !== undefined && !hasScope(request, 'admin')) return adminOnly(reply)
        try {
          const result = await db.transaction(async (tx) => {
            const user = await findUserById(tx, request.params.id)
            return user ? updateUser(tx, requestContext(request), user, request.body) : undefined
          })
          return result ? toUserDto(result.user) : notFound(reply)
        } catch (error) {
          if (isUniqueViolation(error)) return conflict(reply)
          throw error
        }
      },
    )

    app.delete(
      '/users/:id',
      {
        onRequest,
        schema: {
          tags: ['Users'],
          summary: 'Delete a user',
          description: 'Removes the user, their claims and devices. The audit log keeps who they were.',
          params: z.object({ id: z.uuid() }),
          response: { 204: z.null(), ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const deleted = await db.transaction(async (tx) => {
          const user = await findUserById(tx, request.params.id)
          if (!user) return false
          await deleteUser(tx, requestContext(request), user)
          return true
        })
        return deleted ? reply.code(204).send(null) : notFound(reply)
      },
    )

    app.put(
      '/users/by-email/:email',
      {
        onRequest,
        schema: {
          tags: ['Users'],
          summary: 'Create or update a user by e-mail',
          description:
            'Idempotent, so an hourly import can call it blindly. Updates names, phone and language; never the ' +
            'password, status or administrator rights. With `claims`, replaces the values of exactly the claim types ' +
            'given (see PUT /users/{id}/claims). Writes nothing and says `unchanged` when nothing differs. ' +
            'Everything happens in one transaction: if a claim is invalid, the user is not created or changed either.',
          params: z.object({ email }),
          body: z.object({
            firstName: name,
            lastName: name,
            phone: phone.nullable().optional(),
            language: language.optional(),
            claims: claimValues.optional(),
          }),
          response: {
            200: z.object({ outcome: z.enum(['updated', 'unchanged']), user: userSchema, claims: claimValues }),
            201: z.object({ outcome: z.literal('created'), user: userSchema, claims: claimValues }),
            ...ERROR_RESPONSES,
          },
        },
      },
      async (request, reply) => {
        const { email: address } = request.params
        const { phone: wantedPhone, claims: wantedClaims, ...rest } = request.body
        const profile = { ...rest, ...(wantedPhone !== undefined && { phone: wantedPhone }) }

        const upsert = () =>
          db.transaction(async (tx) => {
            const context = requestContext(request)
            const existing = await findUserByEmail(tx, address)
            const { user, profileChanged } = existing
              ? await updateUser(tx, context, existing, profile).then((result) => ({
                  user: result.user,
                  profileChanged: result.changed,
                }))
              : {
                  user: await createUser(tx, context, { email: address, ...profile, phone: profile.phone ?? undefined }),
                  profileChanged: true,
                }
            const { changed: claimsChanged, claims } = wantedClaims
              ? await setUserClaims(tx, context, user, wantedClaims)
              : { changed: false, claims: await getUserClaims(tx, user.id) }

            const outcome = !existing ? ('created' as const) : profileChanged || claimsChanged ? ('updated' as const) : ('unchanged' as const)
            return { outcome, user, claims }
          })

        return answeringClaimsErrors(reply, async () => {
          let result
          try {
            result = await upsert()
          } catch (error) {
            // Two imports creating the same user at once: the loser finds it on the second try.
            if (!isUniqueViolation(error)) throw error
            result = await upsert()
          }

          const body = { outcome: result.outcome, user: toUserDto(result.user), claims: result.claims }
          return result.outcome === 'created' ? reply.code(201).send(body as never) : reply.send(body as never)
        })
      },
    )
  }
