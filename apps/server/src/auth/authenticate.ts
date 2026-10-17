import { randomBytes } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'
import type { Database } from '@progwise/pforte-db'
import { findUserByEmail } from '@progwise/pforte-db/users'

export type Authenticate = (email: string, password: string) => Promise<{ userId: string } | undefined>

/**
 * Checks an e-mail and password (the first step; the sign-in is complete after the second factor). Every failure looks the same to the caller, and the same
 * amount of hashing work happens whether or not the account exists or can sign in, so the
 * response time does not reveal which e-mails are registered.
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

    if (!user || !canSignIn || !passwordMatches) {
      return undefined
    }
    return { userId: user.id }
  }
}
