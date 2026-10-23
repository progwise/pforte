import { createDb, deleteExpiredOidcPayloads, getDatabaseTime } from '@progwise/pforte-db'
import { deleteOldLoginEvents } from '@progwise/pforte-db/admin'
import { deleteOldCodes } from '@progwise/pforte-db/codes'
import { deleteOldDevices } from '@progwise/pforte-db/devices'
import { deleteOldRateLimits } from '@progwise/pforte-db/rate-limits'
import { buildApp } from './app.js'
import { createAuthenticate } from './auth/authenticate.js'
import { deriveCodeSecrets } from './auth/code-secrets.js'
import { checkConfig, checkDevelopmentLeftovers, startupFailure } from './security/startup-checks.js'
import { bootstrapAdministrator } from './manage/bootstrap.js'
import { ensureAdminUiClient } from './manage/setup.js'
import { createBackground } from './security/background.js'
import { createLoginAudit } from './auth/login-audit.js'
import { createRateLimiter } from './auth/rate-limiter.js'
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
const startupProblems = checkConfig(config)
const { db, pool } = createDb(config.databaseUrl, {
  onError: (error) => app.log.error(error, 'database pool error'),
})

startupProblems.push(...(await checkDevelopmentLeftovers(db).catch(() => [])))
if (startupProblems.length > 0 && config.production) {
  throw new Error(startupFailure(startupProblems))
}

await ensureAdminUiClient(db, config.issuer)

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
const background = createBackground({ onError: (error) => app.log.error(error, 'work after a response failed') })
const limiter = createRateLimiter({ db, secret: deriveCodeSecrets(config.cookieKeys)[0]! })
const audit = createLoginAudit({
  db,
  secret: deriveCodeSecrets(config.cookieKeys)[0]!,
  onError: (error) => app.log.error(error, 'a sign-in event could not be written to the audit log'),
})
const sendPasswordResetCode = createPasswordResetSender({
  db,
  notifier,
  codeSecrets: deriveCodeSecrets(config.cookieKeys),
  issuer: config.issuer,
})
const app = buildApp({
  ui,
  trustProxy: config.trustProxy,
  issuer: config.issuer,
  getDatabaseTime: () => getDatabaseTime(db),
  oidc: { provider, authenticate, db, notifier, cookieKeys: config.cookieKeys, ui, limiter, audit },
  manage: { issuer: config.issuer, cookieKeys: config.cookieKeys, ui, organisation: organisationName, timeZone: config.timeZone },
  account: {
    db,
    sendPasswordResetCode,
    codeSecrets: deriveCodeSecrets(config.cookieKeys),
    notifier,
    selfServiceActivation: config.selfServiceActivation,
    cookieKeys: config.cookieKeys,
    secure: config.issuer.startsWith('https:'),
    issuer: config.issuer,
    ui,
    limiter,
    audit,
    background,
  },
  admin: {
    db,
    provider,
    notifier,
    sendPasswordResetCode,
    limiter,
    allowPrivateAddresses: config.allowPrivateAddresses,
  },
})

for (const warning of warnings) app.log.warn(warning)

if (config.bootstrapAdminEmail) {
  // A failure here, such as a mail server that is down, must not keep the identity service from starting: nothing was
  // changed, and the next start tries again.
  bootstrapAdministrator({ db, email: config.bootstrapAdminEmail, notifier, issuer: config.issuer })
    .then((message) => message && app.log.info(message))
    .catch((error) => app.log.error(error, 'BOOTSTRAP_ADMIN_EMAIL: the first administrator could not be set up; it is tried again at the next start'))
}
if (startupProblems.length > 0) {
  app.log.warn({ problems: startupProblems }, `${startupProblems.length} thing(s) would stop pforte in production (NODE_ENV=production)`)
}

const cleanup = setInterval(() => {
  deleteExpiredOidcPayloads(db).catch((error) => app.log.error(error, 'cleanup of expired OIDC payloads failed'))
  deleteOldCodes(db).catch((error) => app.log.error(error, 'cleanup of old one-time codes failed'))
  if (config.loginAuditRetentionDays > 0) {
    deleteOldLoginEvents(db, config.loginAuditRetentionDays).catch((error) => app.log.error(error, 'cleanup of old sign-in events failed'))
  }
  deleteOldRateLimits(db).catch((error) => app.log.error(error, 'cleanup of old rate limit counters failed'))
  deleteOldDevices(db).catch((error) => app.log.error(error, 'cleanup of old devices failed'))
}, CLEANUP_INTERVAL_MS)
cleanup.unref()

app.addHook('onClose', async () => {
  await background.idle()
  clearInterval(cleanup)
  await pool.end()
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0))
  })
}

await app.listen({ port: config.port, host: '0.0.0.0' })
