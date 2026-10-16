import { createDb, getDatabaseTime } from '@progwise/pforte-db'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const { db, pool } = createDb(config.databaseUrl, {
  onError: (error) => app.log.error(error, 'database pool error'),
})

const app = buildApp({ getDatabaseTime: () => getDatabaseTime(db) })

app.addHook('onClose', async () => {
  await pool.end()
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0))
  })
}

await app.listen({ port: config.port, host: '0.0.0.0' })
