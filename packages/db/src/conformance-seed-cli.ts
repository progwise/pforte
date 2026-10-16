import { seedConformance } from './conformance-seed.js'
import { createDb } from './index.js'

const databaseUrl = process.env.DATABASE_URL
const issuer = process.env.ISSUER
const alias = process.env.CONFORMANCE_ALIAS
if (!databaseUrl || !issuer || !alias) {
  throw new Error('DATABASE_URL, ISSUER and CONFORMANCE_ALIAS are required (see .env.conformance.example)')
}

const { db, pool } = createDb(databaseUrl)
try {
  const { clients, user, redirectUris } = await seedConformance(db, { alias })

  console.log(`
Enter these in the OpenID conformance suite (fresh values; earlier ones no longer work):

  Alias                  ${alias}
  Discovery URL          ${issuer}/.well-known/openid-configuration

  Client 1  client_id    ${clients[0]!.clientId}
            client_secret ${clients[0]!.secret}
  Client 2  client_id    ${clients[1]!.clientId}
            client_secret ${clients[1]!.secret}
  (for the client_secret_post client, use client 1 again)

  Test user (sign in on pforte's login page when a test asks you to)
            e-mail       ${user.email}
            password     ${user.password}

Registered redirect URIs on both clients:
${redirectUris.map((uri) => `  ${uri}`).join('\n')}
`)
} finally {
  await pool.end()
}
