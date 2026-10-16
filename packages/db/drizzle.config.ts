import { resolve } from 'node:path'
import { defineConfig } from 'drizzle-kit'

// Scripts run from packages/db; the shared .env lives in the repository root.
try {
  process.loadEnvFile(resolve(process.cwd(), '../../.env'))
} catch {
  // No .env file: DATABASE_URL must come from the environment.
}

export default defineConfig({
  dialect: 'postgresql',
  casing: 'snake_case',
  schema: './src/schema/index.ts',
  out: './drizzle',
  // Only `migrate` connects; `generate` works without a database.
  dbCredentials: { url: process.env.DATABASE_URL as string },
})
