import { createHmac } from 'node:crypto'

/**
 * A short keyed hash of an e-mail address: the same address always gives the same value, but the address
 * cannot be read back from it, and the value is useless without the key. `purpose` keeps the values of
 * different uses (rate limits, audit events) from being compared with each other.
 */
export const hashAddress = (secret: string, purpose: string, email: string, length = 24) =>
  createHmac('sha256', secret).update(`${purpose}:${email.trim().toLowerCase()}`).digest('hex').slice(0, length)
