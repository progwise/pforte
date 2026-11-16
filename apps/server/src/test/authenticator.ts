import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'

/**
 * A device with passkeys, in software: it makes key pairs and answers the questions of pforte the way a phone or
 * a password manager does, in the JSON form a browser passes on. The tests of the server use it; what the script
 * in the page does with a real browser is tested apart, with Chromium's own virtual authenticator.
 *
 * Every part of an answer can be bent, to see that pforte refuses what a real device would never send.
 */

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')

/** Just enough CBOR for an attestation object and a COSE key: numbers, byte strings, text and maps. */
const head = (major: number, value: number) => {
  if (value < 24) return Buffer.from([(major << 5) | value])
  if (value < 256) return Buffer.from([(major << 5) | 24, value])
  return Buffer.from([(major << 5) | 25, value >> 8, value & 0xff])
}
type Cbor = number | string | Uint8Array | Map<number | string, Cbor>
const cbor = (value: Cbor): Buffer => {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)])
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value])
  return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)])])
}

export interface CreationQuestion {
  challenge: string
  rp: { id?: string }
}

export interface AnswerOptions {
  /** The origin of the page the device believes it is on. pforte's own, unless a test says otherwise. */
  origin?: string
  /** The host the passkey is made for. The one in the question, unless a test says otherwise. */
  rpId?: string
  /** Whether the device checked the person (face, finger, PIN). */
  userVerified?: boolean
  /** Whether the passkey is synced to the person's other devices. */
  synced?: boolean
  /** The challenge the answer is for. The one in the question, unless a test says otherwise. */
  challenge?: string
}

export const createAuthenticator = ({ origin }: { /** pforte's origin, where its pages are. */ origin: string }) => ({
  /** Makes a passkey and returns the answer a browser would post. */
  create(question: CreationQuestion, { origin: page = origin, rpId = question.rp.id ?? new URL(origin).hostname, userVerified = true, synced = false, challenge = question.challenge }: AnswerOptions = {}) {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwk = publicKey.export({ format: 'jwk' })
    const credentialId = randomBytes(32)
    const coseKey = cbor(
      new Map<number, Cbor>([
        [1, 2], // key type: elliptic curve
        [3, -7], // algorithm: ES256
        [-1, 1], // curve: P-256
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    )
    // Flags: the person was there (1), was checked (4), the passkey can be synced and is (8, 16), and a new credential follows (64).
    const flags = 0x01 | (userVerified ? 0x04 : 0) | (synced ? 0x08 | 0x10 : 0) | 0x40
    const authenticatorData = Buffer.concat([
      createHash('sha256').update(rpId).digest(),
      Buffer.from([flags]),
      Buffer.alloc(4), // signature counter
      Buffer.alloc(16), // the make of the device: not said
      Buffer.from([credentialId.length >> 8, credentialId.length & 0xff]),
      credentialId,
      coseKey,
    ])
    const attestationObject = cbor(
      new Map<string, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authenticatorData],
      ]),
    )
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: page, crossOrigin: false }))
    return {
      id: text(credentialId),
      rawId: text(credentialId),
      type: 'public-key',
      response: { clientDataJSON: text(clientData), attestationObject: text(attestationObject), transports: ['internal', 'hybrid'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    }
  },
})

export type Authenticator = ReturnType<typeof createAuthenticator>
