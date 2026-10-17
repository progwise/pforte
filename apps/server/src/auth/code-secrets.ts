import { createHmac } from 'node:crypto'

/**
 * The secrets that sign one-time codes, derived from the cookie keys so that no further secret has to
 * be configured. The first one signs, all verify, so rotating the cookie keys keeps codes working.
 */
export const deriveCodeSecrets = (cookieKeys: string[]) =>
  cookieKeys.map((key) => createHmac('sha256', key).update('one-time-code').digest('hex'))
