import type { NewPasskey } from '@progwise/pforte-db/admin'
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'

/** What a device is asked when a passkey is created; the page hands it to the browser as it is. */
export type PasskeyCreationOptions = Awaited<ReturnType<typeof generateRegistrationOptions>>
/** What a device is asked when somebody signs in with a passkey. */
export type PasskeyRequestOptions = Awaited<ReturnType<typeof generateAuthenticationOptions>>

/** A passkey as it is stored, as far as checking a signature needs it. */
export interface StoredPasskey {
  credentialId: string
  publicKey: string
  counter: number
  transports: string[]
}

/** What an answer of a device looks like from outside, before anything in it is trusted. */
interface AnswerShape {
  id?: unknown
  response?: { clientDataJSON?: unknown; userHandle?: unknown }
}

/**
 * The challenge an answer says it is for, and the passkey it says it is from. Both are read only to find the
 * question and the passkey; whether the answer is one is checked after, against what was found.
 */
export const namedBy = (answer: unknown) => {
  try {
    const { id, response } = (answer ?? {}) as AnswerShape
    const clientData = typeof response?.clientDataJSON === 'string' ? (JSON.parse(Buffer.from(response.clientDataJSON, 'base64url').toString()) as { challenge?: unknown } | null) : undefined
    return {
      challenge: typeof clientData?.challenge === 'string' && clientData.challenge ? clientData.challenge : undefined,
      credentialId: typeof id === 'string' && id ? id : undefined,
      /** The person the device says the passkey belongs to, as it was given their id when the passkey was made. */
      userHandle: typeof response?.userHandle === 'string' && response.userHandle ? response.userHandle : undefined,
    }
  } catch {
    return { challenge: undefined, credentialId: undefined, userHandle: undefined }
  }
}

export interface PasskeyOwner {
  id: string
  email: string
  firstName: string
  lastName: string
}

/** The 16 bytes of a UUID: what a passkey carries as the id of its person. It says nothing about them. */
const uuidBytes = (id: string) => new Uint8Array(Buffer.from(id.replaceAll('-', ''), 'hex'))

/** Whether the person a device names (`userHandle`, base64url) is this one. */
export const isHandleOf = (userHandle: string, userId: string) => Buffer.from(userHandle, 'base64url').equals(Buffer.from(uuidBytes(userId)))

/**
 * The two halves of creating a passkey (WebAuthn registration), with the rules pforte has for every passkey:
 * it lives on the device or in its password manager and can be found there without a user name (discoverable),
 * the device checks the person itself (face, finger or PIN) every time, and no attestation is asked for: pforte
 * does not care which make of device it is.
 *
 * A passkey is bound to the host of the issuer for good. Under another host no device offers it any more.
 */
export const createPasskeyCeremonies = ({ issuer, name }: { issuer: string; /** Shown by the device when it asks. */ name?: string }) => {
  const { origin, hostname } = new URL(issuer)

  return {
    /** The relying party: the host of pforte's address. */
    rpId: hostname,
    origin,

    /** What to ask the device. `existing` are the person's passkeys: a device that holds one of them refuses to make a second. */
    creationOptions: (user: PasskeyOwner, existing: { credentialId: string; transports: string[] }[]) =>
      generateRegistrationOptions({
        rpName: name || hostname,
        rpID: hostname,
        userID: uuidBytes(user.id),
        userName: user.email,
        userDisplayName: `${user.firstName} ${user.lastName}`.trim() || user.email,
        attestationType: 'none',
        excludeCredentials: existing.map((passkey) => ({ id: passkey.credentialId, transports: passkey.transports })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      }),

    /**
     * Checks the answer of the device against the challenge it was given: made for this challenge, on a page of
     * pforte's own origin, for pforte's host, and after the device checked the person. Returns what to store, or
     * undefined for an answer that is none.
     */
    verifyCreation: async (answer: unknown, challenge: string): Promise<Omit<NewPasskey, 'label'> | undefined> => {
      try {
        const { verified, registrationInfo } = await verifyRegistrationResponse({
          response: answer as RegistrationResponseJSON,
          expectedChallenge: challenge,
          expectedOrigin: origin,
          expectedRPID: hostname,
          requireUserVerification: true,
        })
        if (!verified || !registrationInfo) return undefined
        const { credential, credentialBackedUp } = registrationInfo
        return {
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString('base64url'),
          counter: credential.counter,
          transports: credential.transports ?? [],
          synced: credentialBackedUp,
        }
      } catch {
        // The library throws for everything that does not add up: a wrong challenge, origin or host, no check of
        // the person, or data that is not an answer at all.
        return undefined
      }
    },

    /**
     * What to ask a device when somebody signs in. No passkey is named: the device offers the ones it holds for
     * pforte's host, so the question says nothing about who has an account.
     */
    requestOptions: () => generateAuthenticationOptions({ rpID: hostname, userVerification: 'required', allowCredentials: [] }),

    /**
     * Checks a sign-in: the answer is signed with the key of this passkey, for this challenge, on a page of
     * pforte's own origin, for pforte's host, after the device checked the person, and its counter did not go
     * back. Returns what to note about the passkey, or undefined for an answer that is none.
     */
    verifySignIn: async (answer: unknown, challenge: string, passkey: StoredPasskey): Promise<{ counter: number; synced: boolean } | undefined> => {
      try {
        const { verified, authenticationInfo } = await verifyAuthenticationResponse({
          response: answer as AuthenticationResponseJSON,
          expectedChallenge: challenge,
          expectedOrigin: origin,
          expectedRPID: hostname,
          credential: { id: passkey.credentialId, publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')), counter: passkey.counter, transports: passkey.transports },
          requireUserVerification: true,
        })
        return verified ? { counter: authenticationInfo.newCounter, synced: authenticationInfo.credentialBackedUp } : undefined
      } catch {
        return undefined
      }
    },
  }
}

export type PasskeyCeremonies = ReturnType<typeof createPasskeyCeremonies>
