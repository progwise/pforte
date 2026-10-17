import { createDb, deleteExpiredOidcPayloads, getDatabaseTime } from '@progwise/pforte-db'
import { deleteOldCodes } from '@progwise/pforte-db/codes'
import { deleteOldDevices } from '@progwise/pforte-db/devices'
import { buildApp } from './app.js'
import { createAuthenticate } from './auth/authenticate.js'
import { deriveCodeSecrets } from './auth/code-secrets.js'
import { createPasswordResetSender } from './auth/password-reset.js'
import { loadConfig } from './config.js'
import { createSmtpMailer } from './notifications/mailer.js'
import { createHttpSmsSender } from './notifications/sms.js'
import { createLogNotifier, createMailNotifier } from './notifications/notifier.js'
import { loadBrand } from './ui/brand.js'
import { createUi } from './ui/index.js'
import { defaultTheme } from './ui/theme.js'
import { loadLocaleOverrides } from './i18n/overrides.js'
import { createProviderHolder } from './oidc/provider.js'

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

const config = loadConfig()
const texts = config.brandingDir ? loadLocaleOverrides(config.brandingDir) : { overrides: {}, warnings: [] }
const brand = config.brandingDir ? loadBrand(config.brandingDir) : { theme: defaultTheme(), name: undefined, warnings: [] }
const warnings = [...texts.warnings, ...brand.warnings]
const organisationName = brand.name ?? config.organisationName
const ui = createUi({
  overrides: texts.overrides,
  defaultLanguage: config.defaultLanguage,
  rememberDeviceDefault: config.rememberDeviceDefault,
  theme: brand.theme,
})
const { db, pool } = createDb(config.databaseUrl, {
  onError: (error) => app.log.error(error, 'database pool error'),
})

const provider = await createProviderHolder({
  config,
  db,
  ui,
  onError: (error) => app.log.error(error, 'OpenID provider error'),
})
const authenticate = await createAuthenticate(db)
const notifier = config.mail
  ? createMailNotifier({
      mailer: createSmtpMailer({ url: config.mail.smtpUrl, from: config.mail.from }),
      sms: config.sms && createHttpSmsSender(config.sms),
      organisation: organisationName,
      i18n: ui.i18n,
    })
  : createLogNotifier({
      log: (message) => app.log.info(message),
      production: process.env.NODE_ENV === 'production',
      smsAvailable: Boolean(config.sms),
    })
const sendPasswordResetCode = createPasswordResetSender({
  db,
  notifier,
  codeSecrets: deriveCodeSecrets(config.cookieKeys),
  issuer: config.issuer,
})
const app = buildApp({
  ui,
  getDatabaseTime: () => getDatabaseTime(db),
  oidc: { provider, authenticate, db, notifier, cookieKeys: config.cookieKeys, ui },
  account: {
    db,
    sendPasswordResetCode,
    codeSecrets: deriveCodeSecrets(config.cookieKeys),
    notifier,
    cookieKeys: config.cookieKeys,
    secure: config.issuer.startsWith('https:'),
    ui,
  },
  admin: {
    db,
    provider,
    notifier,
    sendPasswordResetCode,
  },
})

for (const warning of warnings) app.log.warn(warning)

const cleanup = setInterval(() => {
  deleteExpiredOidcPayloads(db).catch((error) => app.log.error(error, 'cleanup of expired OIDC payloads failed'))
  deleteOldCodes(db).catch((error) => app.log.error(error, 'cleanup of old one-time codes failed'))
  deleteOldDevices(db).catch((error) => app.log.error(error, 'cleanup of old devices failed'))
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
