import { describe, expect, it } from 'vitest'
import { adoptNewDevice, deviceCookie, deviceTokens, newDeviceCookie } from './device-cookie.js'

const value = (header: string) => header.split(';')[0]!.split('=')[1]

describe('the cookies of remembered devices', () => {
  it('reads the tokens kept from sign-ins and the one an activation left', () => {
    expect(deviceTokens(undefined)).toEqual([])
    expect(deviceTokens('pforte_device=a.b')).toEqual(['a', 'b'])
    expect(deviceTokens('pforte_device=a.b; pforte_device_new=c')).toEqual(['a', 'b', 'c'])
    expect(deviceTokens('pforte_device_new=c')).toEqual(['c'])
    expect(deviceTokens('pforte_device=a.b; pforte_device_new=b')).toEqual(['a', 'b'])
  })

  it('looks at a few tokens only, however many a browser sends', () => {
    expect(deviceTokens('pforte_device=a.b.c.d.e.f.g; pforte_device_new=n')).toEqual(['a', 'b', 'c', 'd', 'e', 'n'])
  })

  it('takes one token from an activation, and nothing that does not look like one', () => {
    expect(deviceTokens('pforte_device_new=a.b.c.d')).toEqual([])
    expect(deviceTokens('pforte_device_new=a b')).toEqual([])
    expect(adoptNewDevice('pforte_device=a; pforte_device_new=x.y.z', true)).toEqual([])
  })

  it('keeps the newest tokens when there are too many', () => {
    expect(value(deviceCookie(['a', 'b', 'c', 'd', 'e', 'f'], true))).toBe('b.c.d.e.f')
  })

  it('moves the token of an activation to the others and clears its own cookie', () => {
    expect(adoptNewDevice('pforte_device=a.b', true)).toEqual([])
    const [kept, cleared] = adoptNewDevice('pforte_device=a.b.c.d.e; pforte_device_new=n', true)
    expect(value(kept!)).toBe('b.c.d.e.n')
    expect(kept).toContain('Path=/interaction')
    expect(cleared).toMatch(/^pforte_device_new=; Path=\/interaction; Max-Age=0; /)
  })

  it('sets both on the sign-in pages only, for 90 days, out of reach of scripts and other sites', () => {
    for (const cookie of [deviceCookie(['a'], true), newDeviceCookie('a', true)]) {
      expect(cookie).toContain(`Path=/interaction; Max-Age=${90 * 24 * 60 * 60}; HttpOnly; SameSite=Strict; Secure`)
    }
    expect(newDeviceCookie('a', false)).not.toContain('Secure')
  })
})
