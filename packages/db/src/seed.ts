import { hash } from '@node-rs/argon2'
import type { Database } from './index.js'
import { claimTypes, clientClaimTypes, clients, userClaims, users } from './schema/index.js'

/** Password of every seeded user and the secret of the seeded confidential client. Dev only. */
export const SEED_PASSWORD = 'dev-password'
export const SEED_CLIENT_SECRET = 'dev-secret'

const fictionalUsers = [
  ['anna.schmidt', 'Anna', 'Schmidt', ['00892']],
  ['ben.keller', 'Ben', 'Keller', ['00893', '00894']],
  ['carla.berger', 'Carla', 'Berger', ['00895']],
  ['david.roth', 'David', 'Roth', ['00896']],
  ['emma.vogel', 'Emma', 'Vogel', ['00897', '00898']],
  ['felix.brandt', 'Felix', 'Brandt', ['00899']],
  ['greta.lang', 'Greta', 'Lang', ['00900']],
  ['hans.weber', 'Hans', 'Weber', ['00901']],
  ['ida.sommer', 'Ida', 'Sommer', ['00902']],
  ['jonas.fuchs', 'Jonas', 'Fuchs', ['00903']],
] as const

/**
 * Fills an empty or existing database with fictional development data: one administrator,
 * three claim types, four clients (two applications, two admin clients) and ten users with claims. Safe to run repeatedly.
 */
export const seed = async (db: Database) => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV is production. The seed data has a known password.')
  }

  const passwordHash = await hash(SEED_PASSWORD)
  const secretHash = await hash(SEED_CLIENT_SECRET)

  await db
    .insert(claimTypes)
    .values([
      { key: 'partner_no', description: 'Partner number', valuePattern: '^[0-9]{5}$', multiValued: true },
      { key: 'customer_no', description: 'Customer number', valuePattern: '^[0-9]{5}$' },
      { key: 'branch_code', description: 'Branch code' },
    ])
    .onConflictDoNothing()

  await db
    .insert(clients)
    .values([
      {
        clientId: 'demo-web',
        name: 'Demo web app (public client)',
        type: 'public',
        clientUri: 'http://localhost:3400/',
        redirectUris: ['http://localhost:3400/callback'],
        postLogoutRedirectUris: ['http://localhost:3400/'],
      },
      {
        clientId: 'demo-backend',
        name: 'Demo backend (confidential client)',
        type: 'confidential',
        secretHash,
        clientUri: 'http://localhost:3500/',
        redirectUris: ['http://localhost:3500/callback'],
        postLogoutRedirectUris: ['http://localhost:3500/'],
      },
      // Machines for the admin API: client_credentials grant, admin scopes only.
      {
        clientId: 'demo-admin',
        name: 'Demo admin client (admin scope)',
        type: 'confidential',
        secretHash,
        allowedGrants: ['client_credentials'],
        scopes: ['admin'],
      },
      {
        clientId: 'demo-import',
        name: 'Demo import client (directory scope: users and claims)',
        type: 'confidential',
        secretHash,
        allowedGrants: ['client_credentials'],
        scopes: ['directory'],
      },
    ])
    .onConflictDoNothing()

  await db
    .insert(clientClaimTypes)
    .values([
      { clientId: 'demo-web', claimTypeKey: 'partner_no' },
      { clientId: 'demo-backend', claimTypeKey: 'partner_no' },
      { clientId: 'demo-backend', claimTypeKey: 'customer_no' },
      { clientId: 'demo-backend', claimTypeKey: 'branch_code' },
    ])
    .onConflictDoNothing()

  await db
    .insert(users)
    .values({
      email: 'admin@example.com',
      passwordHash,
      firstName: 'Ada',
      lastName: 'Admin',
      status: 'active',
      isAdmin: true,
    })
    .onConflictDoNothing()

  const insertedUsers = await db
    .insert(users)
    .values(
      fictionalUsers.map(([name, firstName, lastName], index) => ({
        email: `${name}@example.com`,
        passwordHash,
        phone: `+4915100000${String(index + 1).padStart(3, '0')}`,
        phoneVerifiedAt: new Date(),
        firstName,
        lastName,
        language: index % 2 === 0 ? 'de' : 'en',
        status: 'active' as const,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: users.id, email: users.email })

  const idByEmail = new Map(insertedUsers.map((user) => [user.email, user.id]))
  const claimRows = fictionalUsers.flatMap(([name, , , partnerNumbers]) => {
    const userId = idByEmail.get(`${name}@example.com`)
    return userId ? partnerNumbers.map((value) => ({ userId, claimTypeKey: 'partner_no', value })) : []
  })
  if (claimRows.length > 0) {
    await db.insert(userClaims).values(claimRows).onConflictDoNothing()
  }

  return { newUsers: insertedUsers.length }
}
