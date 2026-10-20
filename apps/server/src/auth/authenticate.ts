import { randomBytes } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'
import type { Database } from '@progwise/pforte-db'
import { findUserByEmail } from '@progwise/pforte-db/users'

/** Why a sign-in was refused. The person is only ever told "e-mail or password is not correct"; the audit log gets the reason. */
export type AuthFailure = 'unknown_user' | 'not_allowed' | 'wrong_password'

export type AuthResult = { ok: true; userId: string } | { ok: false; reason: AuthFailure; userId?: string }

export type Authenticate = (email: string, password: string) => Promise<AuthResult>

/**
 * Checks an e-mail and password (the first step; the sign-in is complete after the second factor).
 * Every failure looks the same to the caller's visitor, and the same amount of hashing work happens
 * whether or not the account exists or can sign in, so the response time does not reveal which
 * e-mails are registered.
 */
export const createAuthenticate = async (db: Database): Promise<Authenticate> => {
  const dummyHash = await hash(randomBytes(16).toString('hex'))

  return async (email, password) => {
    const user = await findUserByEmail(db, email)
    const canSignIn = user?.status === 'active' && Boolean(user.passwordHash)
    const candidate = canSignIn ? (user?.passwordHash as string) : dummyHash

    let passwordMatches = false
    try {
      passwordMatches = await verify(candidate, password)
    } catch {
      passwordMatches = false
    }

    if (!user) return { ok: false, reason: 'unknown_user' }
    if (!canSignIn) return { ok: false, reason: 'not_allowed', userId: user.id }
    if (!passwordMatches) return { ok: false, reason: 'wrong_password', userId: user.id }
    return { ok: true, userId: user.id }
  }
}
