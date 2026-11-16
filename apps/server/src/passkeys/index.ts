import type { Ui } from '../ui/index.js'
import { createPasskeyCeremonies } from './ceremonies.js'
import { createPasskeyScript } from './script.js'

/** Everything a page needs for passkeys: what to ask a device and how to check its answer, and the script that asks. */
export const createPasskeys = ({ issuer, ui, name }: { issuer: string; ui: Pick<Ui, 'pages'>; /** Shown by the device when it asks. */ name?: string }) => ({
  ceremonies: createPasskeyCeremonies({ issuer, name }),
  script: createPasskeyScript({ issuer, ui }),
})

export type Passkeys = ReturnType<typeof createPasskeys>

export { passkeyLabel } from './label.js'
