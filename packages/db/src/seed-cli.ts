import { createDb } from './index.js'
import { SEED_CLIENT_SECRET, SEED_PASSWORD, seed } from './seed.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required')
}

const { db, pool } = createDb(databaseUrl)
try {
  const { newUsers } = await seed(db)
  console.log(`Seeded ${newUsers} new users (existing rows were left unchanged).`)
  console.log(`Sign in as admin@example.com or any user @example.com with password "${SEED_PASSWORD}".`)
  console.log(`Confidential client demo-backend uses the secret "${SEED_CLIENT_SECRET}".`)
} finally {
  await pool.end()
}
