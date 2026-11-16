import { createFlash } from '../own-login/flash.js'
import { MANAGE_PATH } from './constants.js'

export type { Flash } from '../own-login/flash.js'

const flash = createFlash({ cookie: 'pforte_manage_flash', path: MANAGE_PATH })

/** Remember a message for the next page of the administration. */
export const setFlash = flash.set
/** The message left for this page, if any. Also clears it, so it is shown once. */
export const takeFlash = flash.take
