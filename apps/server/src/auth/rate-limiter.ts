import { createHmac } from 'node:crypto'
import type { Database } from '@progwise/pforte-db'
import { blockedFor, clear, clearPrefix, consume, count, type Rule } from '@progwise/pforte-db/rate-limits'

const FIFTEEN_MINUTES = 15 * 60
const ONE_HOUR = 60 * 60

/** What is allowed. These numbers are documented in docs/rate-limiting.md. */
export const LIMITS = {
  /** Wrong passwords for one address from one IP, for one address from anywhere, and from one IP for any address. */
  passwordPerAddressAndIp: { max: 5, windowSeconds: FIFTEEN_MINUTES },
  passwordPerAddress: { max: 20, windowSeconds: FIFTEEN_MINUTES },
  passwordPerIp: { max: 30, windowSeconds: FIFTEEN_MINUTES },
  /** Wrong codes from one IP, on top of the five attempts each code has. */
  codeFailuresPerIp: { max: 30, windowSeconds: FIFTEEN_MINUTES },
  /** Codes that people ask for again, from one IP. The first code of a sign-in is not counted: it needs the password. */
  codeResendsPerIp: { max: 10, windowSeconds: ONE_HOUR },
  /** Many people can sit behind one address, so this is generous; the limit per address protects a mailbox. */
  resetPerIp: { max: 30, windowSeconds: ONE_HOUR },
  resetPerAddress: { max: 5, windowSeconds: ONE_HOUR },
  /** Activation links that were wrong, from one IP. */
  activationFailuresPerIp: { max: 20, windowSeconds: FIFTEEN_MINUTES },
  /** Failed authentications of a client or an administrator, from one IP. */
  clientAuthFailuresPerIp: { max: 30, windowSeconds: FIFTEEN_MINUTES },
} as const

/**
 * What counts as "the same network": an IPv4 address as it is, an IPv6 address as its /64, since one
 * connection usually holds a whole /64 and an attacker would otherwise change addresses at will.
 */
export const ipKey = (ip: string | undefined) => {
  if (!ip) return 'unknown'
  const address = ip.split('%')[0]!.toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address)
  if (mapped) return mapped[1]!
  if (!address.includes(':')) return address

  const [head = '', tail = ''] = address.split('::')
  const headParts = head ? head.split(':') : []
  const tailParts = tail ? tail.split(':') : []
  const zeros = address.includes('::') ? Array<string>(Math.max(8 - headParts.length - tailParts.length, 0)).fill('0') : []
  const groups = [...headParts, ...zeros, ...tailParts].slice(0, 4).map((group) => group.padStart(4, '0'))
  return `${groups.join(':')}::/64`
}

export interface RateLimiter {
  /** Seconds to wait before this address may try a password from this IP; 0 if it may. Counts nothing. */
  passwordBlockedFor(email: string, ip: string | undefined): Promise<number>
  passwordFailed(email: string, ip: string | undefined): Promise<void>
  /** A right password forgives the earlier mistakes of this address from this IP. */
  passwordSucceeded(email: string, ip: string | undefined): Promise<void>
  codeBlockedFor(ip: string | undefined): Promise<number>
  codeFailed(ip: string | undefined): Promise<void>
  /** Counts a request for another code and returns the wait if that was one too many. */
  codeResend(ip: string | undefined): Promise<number>
  /** Counts a password reset request for the address and the IP, and returns the wait if it was one too many. */
  resetRequest(email: string, ip: string | undefined): Promise<number>
  activationBlockedFor(ip: string | undefined): Promise<number>
  activationFailed(ip: string | undefined): Promise<void>
  clientAuthBlockedFor(ip: string | undefined): Promise<number>
  clientAuthFailed(ip: string | undefined): Promise<void>
  /** Forgets everything counted against an address, so an administrator can let someone in at once. */
  forgetAddress(email: string): Promise<void>
}

export interface RateLimiterOptions {
  db: Database
  /** Keys the hash of e-mail addresses, so the counters cannot be traced back to them. */
  secret: string
  now?: () => Date
}

export const createRateLimiter = ({ db, secret, now = () => new Date() }: RateLimiterOptions): RateLimiter => {
  const address = (email: string) => createHmac('sha256', secret).update(`rate-limit:${email.trim().toLowerCase()}`).digest('hex').slice(0, 24)
  const rule = (key: string, limit: { max: number; windowSeconds: number }): Rule => ({ key, ...limit })

  const passwordRules = (email: string, ip: string | undefined) => {
    const a = address(email)
    const i = ipKey(ip)
    return [
      rule(`pw:addrip:${a}:${i}`, LIMITS.passwordPerAddressAndIp),
      rule(`pw:addr:${a}`, LIMITS.passwordPerAddress),
      rule(`pw:ip:${i}`, LIMITS.passwordPerIp),
    ]
  }

  return {
    passwordBlockedFor: (email, ip) => blockedFor(db, passwordRules(email, ip), now()),
    passwordFailed: (email, ip) => count(db, passwordRules(email, ip), now()),
    passwordSucceeded: (email, ip) => clear(db, [`pw:addrip:${address(email)}:${ipKey(ip)}`]),
    codeBlockedFor: (ip) => blockedFor(db, [rule(`code:ip:${ipKey(ip)}`, LIMITS.codeFailuresPerIp)], now()),
    codeFailed: (ip) => count(db, [rule(`code:ip:${ipKey(ip)}`, LIMITS.codeFailuresPerIp)], now()),
    codeResend: (ip) => consume(db, rule(`coderesend:ip:${ipKey(ip)}`, LIMITS.codeResendsPerIp), now()),
    async resetRequest(email, ip) {
      // Both are counted, whatever the first one says, so that neither counter lags behind.
      const waits = [
        await consume(db, rule(`reset:ip:${ipKey(ip)}`, LIMITS.resetPerIp), now()),
        await consume(db, rule(`reset:addr:${address(email)}`, LIMITS.resetPerAddress), now()),
      ]
      return Math.max(...waits)
    },
    activationBlockedFor: (ip) => blockedFor(db, [rule(`activate:ip:${ipKey(ip)}`, LIMITS.activationFailuresPerIp)], now()),
    activationFailed: (ip) => count(db, [rule(`activate:ip:${ipKey(ip)}`, LIMITS.activationFailuresPerIp)], now()),
    clientAuthBlockedFor: (ip) => blockedFor(db, [rule(`clientauth:ip:${ipKey(ip)}`, LIMITS.clientAuthFailuresPerIp)], now()),
    clientAuthFailed: (ip) => count(db, [rule(`clientauth:ip:${ipKey(ip)}`, LIMITS.clientAuthFailuresPerIp)], now()),
    async forgetAddress(email) {
      const a = address(email)
      await clearPrefix(db, `pw:addrip:${a}:`)
      await clear(db, [`pw:addr:${a}`, `reset:addr:${a}`])
    },
  }
}
