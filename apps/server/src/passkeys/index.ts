import type { Database } from '@progwise/pforte-db'
import type { Notifier } from '../notifications/notifier.js'
import type { Background } from '../security/background.js'
import type { Ui } from '../ui/index.js'
import { createPasskeyCeremonies } from './ceremonies.js'
import { createPasskeyEnrolment } from './enrolment.js'
import { createPasskeyOffers } from './offer.js'
import { createPasskeyScript } from './script.js'

export interface PasskeysOptions {
  /** The public address of pforte. Its host is what every passkey is made for. */
  issuer: string
  ui: Ui
  db: Database
  notifier: Pick<Notifier, 'sendPasskeyAdded'>
  background: Background
  /** Sign the cookie that remembers who answered the offer of a passkey. */
  cookieKeys: string[]
  /** Shown by the device when it asks. */
  name?: string
  /** Whether the account pages exist, where a person removes a passkey: the mail about a new one links there. */
  accountPages: boolean
}

/**
 * Everything the pages need for passkeys: what to ask a device and how to check its answer, how a person gets a
 * new one, who was offered one already, and the script that asks.
 */
export const createPasskeys = ({ issuer, ui, db, notifier, background, cookieKeys, name, accountPages }: PasskeysOptions) => {
  const ceremonies = createPasskeyCeremonies({ issuer, name })
  return {
    ceremonies,
    enrolment: createPasskeyEnrolment({ db, ceremonies, ui, notifier, background, accountUrl: accountPages ? `${issuer}/account/passkeys` : undefined }),
    offers: createPasskeyOffers({ cookieKeys, secure: issuer.startsWith('https:') }),
    script: createPasskeyScript({ issuer, ui }),
  }
}

export type Passkeys = ReturnType<typeof createPasskeys>

export { isHandleOf, namedBy } from './ceremonies.js'
export type { EnrolmentOutcome, StillAllowed } from './enrolment.js'
