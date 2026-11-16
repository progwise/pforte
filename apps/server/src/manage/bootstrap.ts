import type { Database } from '@progwise/pforte-db'
import { ensureAdministrator } from '@progwise/pforte-db/admin'
import type { Notifier } from '../notifications/notifier.js'
import { ADMIN_UI_CLIENT_ID, ADMIN_UI_NAME } from './constants.js'

/**
 * `BOOTSTRAP_ADMIN_EMAIL`: if pforte has no administrator, this address becomes one and is mailed the link to choose
 * a password. Returns what happened, for the log. Throws when the mail cannot be sent, and then nothing was changed.
 */
export const bootstrapAdministrator = async ({
  db,
  email,
  notifier,
  issuer,
}: {
  db: Database
  email: string
  notifier: Pick<Notifier, 'sendActivationLink'>
  issuer: string
}) => {
  // The administration is what this account is for: the mail says so, and the page after choosing the password leads there.
  const result = await ensureAdministrator(
    db,
    email,
    (user, activation) =>
      notifier.sendActivationLink(user, { url: `${issuer}/activate?token=${encodeURIComponent(activation.token)}`, expiresAt: activation.expiresAt, applicationName: ADMIN_UI_NAME }),
    { clientId: ADMIN_UI_CLIENT_ID },
  )
  if (result.outcome === 'exists') return undefined
  const sent = result.activation ? ' The link to choose a password was sent to that address.' : ''
  return `${result.user.email} ${result.outcome === 'created' ? 'was created as' : 'was made'} the first administrator (BOOTSTRAP_ADMIN_EMAIL).${sent}`
}
