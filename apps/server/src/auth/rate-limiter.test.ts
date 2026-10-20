import { createTestDatabase, hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createRateLimiter, ipKey, LIMITS } from './rate-limiter.js'

describe('which network an address belongs to', () => {
  it('keeps an IPv4 address as it is', () => {
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7')
    expect(ipKey('::ffff:203.0.113.7')).toBe('203.0.113.7')
  })

  it('counts a whole IPv6 /64 as one network, however the address is written', () => {
    const net = '2001:0db8:0000:0042::/64'
    expect(ipKey('2001:db8:0:42:aaaa:bbbb:cccc:dddd')).toBe(net.replace('0042::/64', '0042::/64'))
    expect(ipKey('2001:db8:0:42::1')).toBe(ipKey('2001:db8:0:42:ffff:ffff:ffff:ffff'))
    expect(ipKey('2001:db8:0:43::1')).not.toBe(ipKey('2001:db8:0:42::1'))
    expect(ipKey('2001:DB8::1')).toBe(ipKey('2001:db8:0:0::2'))
    expect(ipKey('::1')).toBe('0000:0000:0000:0000::/64')
    expect(ipKey('fe80::1%eth0')).toBe('fe80:0000:0000:0000::/64')
  })

  it('has a name for an unknown address', () => {
    expect(ipKey(undefined)).toBe('unknown')
    expect(ipKey('')).toBe('unknown')
  })
})

describe.skipIf(!hasDatabase)('the limits', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>
  let clock = new Date('2030-01-01T10:00:00Z')
  const limiter = () => createRateLimiter({ db: database.db, secret: 'secret-one', now: () => clock })
  const later = (seconds: number) => {
    clock = new Date(clock.getTime() + seconds * 1000)
  }

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  afterAll(async () => {
    await database?.drop()
  })

  beforeEach(async () => {
    await database.pool.query('delete from rate_limits')
    clock = new Date('2030-01-01T10:00:00Z')
  })

  const fail = async (times: number, email: string, ip: string) => {
    for (let n = 0; n < times; n++) await limiter().passwordFailed(email, ip)
  }

  describe('passwords', () => {
    it('lets five wrong ones through per address and IP, then holds back that pair for the window', async () => {
      await fail(4, 'ada@example.com', '203.0.113.7')
      expect(await limiter().passwordBlockedFor('ada@example.com', '203.0.113.7')).toBe(0)
      await fail(1, 'ada@example.com', '203.0.113.7')
      expect(await limiter().passwordBlockedFor('ada@example.com', '203.0.113.7')).toBe(900)

      later(600)
      expect(await limiter().passwordBlockedFor('ada@example.com', '203.0.113.7')).toBe(300)
      later(300)
      expect(await limiter().passwordBlockedFor('ada@example.com', '203.0.113.7')).toBe(0)
    })

    it('does not hold back the same address from another IP, nor another address from the same IP', async () => {
      await fail(5, 'ada@example.com', '203.0.113.7')
      expect(await limiter().passwordBlockedFor('ada@example.com', '198.51.100.1')).toBe(0)
      expect(await limiter().passwordBlockedFor('bob@example.com', '203.0.113.7')).toBe(0)
    })

    it('holds back an address from every IP after 20 wrong passwords, as in an attack from many addresses', async () => {
      for (let n = 0; n < 20; n++) await limiter().passwordFailed('ada@example.com', `198.51.100.${n}`)
      expect(await limiter().passwordBlockedFor('ada@example.com', '192.0.2.99')).toBe(900)
      expect(await limiter().passwordBlockedFor('bob@example.com', '192.0.2.99')).toBe(0)
    })

    it('holds back an IP after 30 wrong passwords for any addresses, as in credential stuffing', async () => {
      for (let n = 0; n < 30; n++) await limiter().passwordFailed(`user${n}@example.com`, '203.0.113.7')
      expect(await limiter().passwordBlockedFor('new@example.com', '203.0.113.7')).toBe(900)
      expect(await limiter().passwordBlockedFor('new@example.com', '203.0.113.8')).toBe(0)
    })

    it('treats the address the same however it is written', async () => {
      await fail(5, 'Ada@Example.com ', '203.0.113.7')
      expect(await limiter().passwordBlockedFor('ada@example.com', '203.0.113.7')).toBeGreaterThan(0)
    })

    it('forgives the mistakes of an address from an IP when the password is right, but only those', async () => {
      await fail(4, 'ada@example.com', '203.0.113.7')
      await limiter().passwordSucceeded('ada@example.com', '203.0.113.7')
      await fail(4, 'ada@example.com', '203.0.113.7')
      expect(await limiter().passwordBlockedFor('ada@example.com', '203.0.113.7')).toBe(0)
      const { rows } = await database.pool.query(`select hits from rate_limits where key like 'pw:addr:%'`)
      expect(rows[0].hits).toBe(8)
    })

    it('lets an administrator let an address in at once', async () => {
      await fail(5, 'ada@example.com', '203.0.113.7')
      for (let n = 0; n < 20; n++) await limiter().passwordFailed('ada@example.com', `198.51.100.${n}`)
      await limiter().forgetAddress('ada@example.com')
      expect(await limiter().passwordBlockedFor('ada@example.com', '203.0.113.7')).toBe(0)
      expect(await limiter().passwordBlockedFor('ada@example.com', '192.0.2.99')).toBe(0)
    })

    it('never stores an address, only a hash that depends on the secret', async () => {
      await fail(1, 'ada@example.com', '203.0.113.7')
      const { rows } = await database.pool.query('select key from rate_limits order by key')
      expect(rows.map((row) => row.key).join(' ')).not.toContain('ada')
      expect(rows.map((row) => row.key)).toEqual(expect.arrayContaining([expect.stringMatching(/^pw:addr:[0-9a-f]{24}$/)]))

      await database.pool.query('delete from rate_limits')
      await createRateLimiter({ db: database.db, secret: 'another-secret', now: () => clock }).passwordFailed('ada@example.com', '203.0.113.7')
      const other = await database.pool.query('select key from rate_limits')
      expect(rows.map((row) => row.key)).not.toEqual(other.rows.map((row) => row.key))
    })
  })

  describe('codes', () => {
    it('holds back an IP after 30 wrong codes', async () => {
      for (let n = 0; n < 29; n++) await limiter().codeFailed('203.0.113.7')
      expect(await limiter().codeBlockedFor('203.0.113.7')).toBe(0)
      await limiter().codeFailed('203.0.113.7')
      expect(await limiter().codeBlockedFor('203.0.113.7')).toBe(900)
      expect(await limiter().codeBlockedFor('203.0.113.8')).toBe(0)
    })

    it('allows ten resends an hour per IP', async () => {
      for (let n = 0; n < 10; n++) expect(await limiter().codeResend('203.0.113.7')).toBe(0)
      expect(await limiter().codeResend('203.0.113.7')).toBe(3600)
      later(3600)
      expect(await limiter().codeResend('203.0.113.7')).toBe(0)
    })
  })

  describe('password reset requests', () => {
    it('allows five an hour per address, counting every address, even one that does not exist', async () => {
      for (let n = 0; n < 5; n++) expect(await limiter().resetRequest('nobody@example.com', `198.51.100.${n}`)).toBe(0)
      expect(await limiter().resetRequest('nobody@example.com', '198.51.100.99')).toBe(3600)
      expect(await limiter().resetRequest('other@example.com', '198.51.100.99')).toBe(0)
    })

    it('allows 30 an hour per IP', async () => {
      for (let n = 0; n < 30; n++) expect(await limiter().resetRequest(`user${n}@example.com`, '203.0.113.7')).toBe(0)
      expect(await limiter().resetRequest('user31@example.com', '203.0.113.7')).toBe(3600)
    })

    it('counts both even when one of them already says no', async () => {
      for (let n = 0; n < 6; n++) await limiter().resetRequest('ada@example.com', '203.0.113.7')
      const { rows } = await database.pool.query(`select key, hits from rate_limits where key like 'reset:ip:%'`)
      expect(rows[0].hits).toBe(6)
    })
  })

  it('knows the numbers it was told to', () => {
    expect(LIMITS.passwordPerAddressAndIp.max).toBe(5)
    expect(LIMITS.clientAuthFailuresPerIp.max).toBe(30)
  })

  it('holds back an IP after 20 wrong activation links and 30 failed client authentications', async () => {
    for (let n = 0; n < 20; n++) await limiter().activationFailed('203.0.113.7')
    expect(await limiter().activationBlockedFor('203.0.113.7')).toBe(900)
    for (let n = 0; n < 30; n++) await limiter().clientAuthFailed('203.0.113.7')
    expect(await limiter().clientAuthBlockedFor('203.0.113.7')).toBe(900)
    expect(await limiter().clientAuthBlockedFor('203.0.113.8')).toBe(0)
  })
})
