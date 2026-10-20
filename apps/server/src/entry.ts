import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { migrateDatabase } from '@progwise/pforte-db/migrate'
import { HELP, parseCommand, UsageError } from './commands.js'
import { readSecret } from './config.js'
import { generateKeys, keysAsEnvironment, writeKeyFiles } from './keys.js'

/** Next to this file in the image; in a checkout, with the database package. */
const migrationsFolder = () => {
  const candidates = ['./drizzle', '../../../packages/db/drizzle'].map((path) => fileURLToPath(new URL(path, import.meta.url)))
  const found = candidates.find((path) => existsSync(path))
  if (!found) throw new Error(`The database migrations were not found (looked in ${candidates.join(' and ')}).`)
  return found
}

const migrate = async () => {
  const databaseUrl = readSecret(process.env, 'DATABASE_URL')
  if (!databaseUrl) throw new UsageError('DATABASE_URL is required (or DATABASE_URL_FILE).')
  console.log('Checking the database schema …')
  const { applied } = await migrateDatabase(databaseUrl, { migrationsFolder: migrationsFolder() })
  console.log(applied === 0 ? 'The database schema is up to date.' : `Applied ${applied} migration${applied === 1 ? '' : 's'}.`)
}

const main = async () => {
  const command = parseCommand(process.argv.slice(2), process.env)

  switch (command.name) {
    case 'help':
      console.log(HELP)
      return
    case 'version':
      console.log(process.env.PFORTE_VERSION || 'development')
      return
    case 'keys': {
      const keys = generateKeys()
      if (command.dir) {
        const written = writeKeyFiles(command.dir, keys, { force: command.force })
        console.log(`Wrote ${written.join(' and ')}. Point COOKIE_KEYS_FILE and JWKS_FILE at them.`)
      } else {
        process.stdout.write(keysAsEnvironment(keys))
      }
      return
    }
    case 'migrate':
      await migrate()
      return
    case 'start':
      if (command.migrate) await migrate()
      await import('./server.js')
      return
  }
}

main().catch((error: Error) => {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n\n${HELP}`)
    process.exit(2)
  }
  console.error(error.message)
  process.exit(1)
})
