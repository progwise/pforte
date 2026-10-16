import { createDb, deleteExpiredOidcPayloads, getDatabaseTime } from '@progwise/pforte-db'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createProviderHolder } from './oidc/provider.js'

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

const config = loadConfig()
const { db, pool } = createDb(config.databaseUrl, {
  onError: (error) => app.log.error(error, 'database pool error'),
})

const oidc = await createProviderHolder({ config, db })
const app = buildApp({ getDatabaseTime: () => getDatabaseTime(db), oidc })

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
