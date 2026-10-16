import { resolve } from 'node:path'
import { defineConfig } from 'drizzle-kit'

// Scripts run from packages/db; the shared .env lives in the repository root. ENV_FILE (relative
// to the repository root) selects another file, e.g. .env.conformance.
try {
  process.loadEnvFile(resolve(process.cwd(), '../..', process.env.ENV_FILE ?? '.env'))
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
