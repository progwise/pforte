import type { Database } from '@progwise/pforte-db'
import type { Notifier } from '../notifications/notifier.js'
import { createPasskeys } from '../passkeys/index.js'
import { createBackground } from '../security/background.js'
import { createUi } from '../ui/index.js'

/** What the sign-in pages need for passkeys, for a test that builds the app itself and is not about passkeys. */
export const testPasskeys = ({ issuer, db, notifier }: { issuer: string; db: Database; notifier: Pick<Notifier, 'sendPasskeyAdded'> }) =>
  createPasskeys({ issuer, ui: createUi(), db, notifier, background: createBackground({ onError: () => {} }), cookieKeys: ['k'.repeat(40)], accountPages: true })
