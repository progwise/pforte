// Fills COOKIE_KEYS and JWKS in .env with freshly generated development keys.
// Existing values are kept unless --force is given. Usage: node scripts/dev-keys.mjs [--force] [--file <path>]
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const force = args.includes('--force')
const fileIndex = args.indexOf('--file')
const root = resolve(import.meta.dirname, '..')
const envFile = fileIndex === -1 ? resolve(root, '.env') : resolve(args[fileIndex + 1])

if (!existsSync(envFile)) {
  copyFileSync(resolve(root, '.env.example'), envFile)
  console.log(`Created ${envFile} from .env.example`)
}

const generateJwks = () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = privateKey.export({ format: 'jwk' })
  return JSON.stringify({ keys: [{ ...jwk, kid: randomBytes(8).toString('hex'), alg: 'RS256', use: 'sig' }] })
}

const generated = {
  COOKIE_KEYS: () => randomBytes(48).toString('base64url'),
  JWKS: generateJwks,
}

let content = readFileSync(envFile, 'utf8')
for (const [name, generate] of Object.entries(generated)) {
  const line = new RegExp(`^${name}=(.*)$`, 'm')
  const current = content.match(line)?.[1]?.trim().replace(/^'|'$/g, '')
  if (current && !force) {
    console.log(`${name} is already set, keeping it (use --force to replace)`)
    continue
  }
  const entry = `${name}='${generate()}'`
  content = line.test(content) ? content.replace(line, () => entry) : `${content.trimEnd()}\n${entry}\n`
  console.log(`Generated ${name}`)
}
writeFileSync(envFile, content)
