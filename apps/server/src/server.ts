import { createDb, deleteExpiredOidcPayloads, getDatabaseTime } from '@progwise/pforte-db'
import { buildApp } from './app.js'
import { createAuthenticate } from './auth/authenticate.js'
import { loadConfig } from './config.js'
import { createLogNotifier } from './notifications/notifier.js'
import { createProviderHolder } from './oidc/provider.js'

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

const config = loadConfig()
const { db, pool } = createDb(config.databaseUrl, {
  onError: (error) => app.log.error(error, 'database pool error'),
})

const provider = await createProviderHolder({
  config,
  db,
  onError: (error) => app.log.error(error, 'OpenID provider error'),
})
const authenticate = await createAuthenticate(db)
const app = buildApp({
  getDatabaseTime: () => getDatabaseTime(db),
  oidc: { provider, authenticate },
  admin: {
    db,
    provider,
    notifier: createLogNotifier({
      log: (message) => app.log.info(message),
      production: process.env.NODE_ENV === 'production',
    }),
  },
})

const cleanup = setInterval(() => {
  deleteExpiredOidcPayloads(db).catch((error) => app.log.error(error, 'cleanup of expired OIDC payloads failed'))
}, CLEANUP_INTERVAL_MS)
cleanup.unref()

app.addHook('onClose', async () => {
  clearInterval(cleanup)
  await pool.end()
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0))
  })
}

await app.listen({ port: config.port, host: '0.0.0.0' })
