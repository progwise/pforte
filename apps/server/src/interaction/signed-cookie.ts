import { createHmac, timingSafeEqual } from 'node:crypto'

const mac = (key: string, body: string) => createHmac('sha256', key).update(`signed-cookie:${body}`).digest('base64url')

/** `payload` as text that cannot be changed without the key: `<payload>.<signature>`. */
export const sign = (keys: string[], payload: object) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${mac(keys[0]!, body)}`
}

/** The payload if the signature matches any of the keys (older keys still verify), otherwise undefined. */
export const unsign = <T>(keys: string[], value: string | undefined): T | undefined => {
  const [body, signature, ...rest] = value?.split('.') ?? []
  if (!body || !signature || rest.length > 0) return undefined
  const valid = keys.some((key) => {
    const expected = mac(key, body)
    return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  })
  if (!valid) return undefined
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString()) as T
  } catch {
    return undefined
  }
}

export const readCookie = (header: string | undefined, name: string) => {
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=')
    if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim()
  }
  return undefined
}

export interface CookieOptions {
  path: string
  maxAgeSeconds: number
  secure: boolean
}

/** A cookie the script of a page cannot read and other sites cannot send along. */
export const setCookieHeader = (name: string, value: string, { path, maxAgeSeconds, secure }: CookieOptions) =>
  `${name}=${value}; Path=${path}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
