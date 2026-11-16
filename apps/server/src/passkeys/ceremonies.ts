import type { NewPasskey } from '@progwise/pforte-db/admin'
import { generateRegistrationOptions, type RegistrationResponseJSON, verifyRegistrationResponse } from '@simplewebauthn/server'

/** What a device is asked when a passkey is created; the page hands it to the browser as it is. */
export type PasskeyCreationOptions = Awaited<ReturnType<typeof generateRegistrationOptions>>

export interface PasskeyOwner {
  id: string
  email: string
  firstName: string
  lastName: string
}

/** The 16 bytes of a UUID: what a passkey carries as the id of its person. It says nothing about them. */
const uuidBytes = (id: string) => new Uint8Array(Buffer.from(id.replaceAll('-', ''), 'hex'))

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
  }
}

export type PasskeyCeremonies = ReturnType<typeof createPasskeyCeremonies>
