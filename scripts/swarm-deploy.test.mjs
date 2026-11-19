// What examples/swarm/deploy.sh checks before it replaces a running pforte, for codes by SMS. A file it lets
// through and pforte then refuses stops the one instance, so its check is held against the rule of the server.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const swarm = new URL('../examples/swarm/', import.meta.url).pathname
const deployScript = readFileSync(join(swarm, 'deploy.sh'), 'utf8')
const checkFunction = /^is_json_object_of_strings\(\) \{\n[\s\S]*?\n\}\n/m.exec(deployScript)?.[0]

const temporary = mkdtempSync(join(tmpdir(), 'pforte-swarm-'))
after(() => rmSync(temporary, { recursive: true, force: true }))

/** What pforte does with the file behind SMS_HEADERS_FILE (readSecret and parseSms in apps/server/src/config.ts). */
const serverAccepts = (bytes) => {
  const text = bytes.toString('utf8').trim()
  if (!text) return true // no headers at all: pforte starts, and sends without credentials
  try {
    const value = JSON.parse(text)
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((item) => typeof item === 'string')
  } catch {
    return false
  }
}

/** The answers of the script's check for many files at once: one shell for all of them. */
const scriptAccepts = (files, environment = {}) => {
  const folder = mkdtempSync(join(temporary, 'files-'))
  files.forEach((bytes, index) => writeFileSync(join(folder, String(index)), bytes))
  const loop = `${checkFunction}\nfor ((i = 0; i < ${files.length}; i++)); do is_json_object_of_strings "${folder}/$i" && printf y || printf n; done`
  const result = spawnSync('bash', ['-c', loop], { encoding: 'utf8', env: { ...process.env, ...environment } })
  assert.equal(result.stdout.length, files.length, result.stderr)
  return [...result.stdout].map((answer) => answer === 'y')
}

const VALID = [
  '{"X-Api-Key":"fake","Accept":"application/json"}',
  '{}',
  ' {\n\t"Authorization" : "Basic dXNlcjpwYXNz=" ,\r\n\t"Accept": "application/json"\n}\n\n',
  '{"X-Note":"a \\"quoted\\" w\\u00f6rd, bäckslash \\\\ and \\/ and {braces}, [brackets]: all of it"}',
  '{"":""}',
]
const INVALID = {
  'a doubled closing brace': '{"X-Api-Key":"fake"}}',
  'an array': '["X-Api-Key","fake"]',
  'a number as a value': '{"X-Api-Key":123}',
  'an object as a value': '{"X-Api-Key":{"a":"b"}}',
  'a trailing comma': '{"X-Api-Key":"fake",}',
  'a missing quote': '{"X-Api-Key":"fake,"Accept":"application/json"}',
  'single quotes': "{'X-Api-Key':'fake'}",
  'quotes eaten by a shell': '{X-Api-Key:fake,Accept:application/json}',
  'a bare string': '"fake"',
  'null': 'null',
  'an escape JSON does not have': '{"X-Note":"a \\x b"}',
  'a line break inside a value': '{"X-Note":"a\nb"}',
  'a form feed after the colon': '{"X-Api-Key":\f"fake"}',
  'a vertical tab after the comma': '{"X-Api-Key":"fake",\v"Accept":"application/json"}',
  'a no-break space between the parts': '{"X-Api-Key": "fake"}',
  'a NUL byte in a value': '{"X-Api-Key":"fa\0ke"}',
  'a NUL byte between the parts': '{"X-Api-Key":\0"fake"}',
}

test('the check of the headers is there to be tested', () => {
  assert.ok(checkFunction, 'deploy.sh has no function is_json_object_of_strings')
})

test('headers that pforte takes pass the check', () => {
  const files = VALID.map((text) => Buffer.from(text))
  assert.deepEqual(files.map(serverAccepts), VALID.map(() => true))
  assert.deepEqual(scriptAccepts(files), VALID.map(() => true))
})

for (const [name, text] of Object.entries(INVALID)) {
  test(`headers with ${name} are refused, as pforte refuses them`, () => {
    const file = Buffer.from(text)
    assert.equal(serverAccepts(file), false)
    assert.deepEqual(scriptAccepts([file]), [false])
  })
}

test('no file passes the check that pforte would refuse, whatever is done to a good one', () => {
  // The same files at every run: a generator with a fixed start.
  let state = 0x2f6e2b1
  const random = (below) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state % below
  }
  const pick = (list) => list[random(list.length)]
  // What a typo, an editor or a copy from somewhere can put into a file: every character JSON gives a meaning to,
  // everything that looks like white space, control characters, and bytes that are no text at all.
  const PIECES = ['"', '\\', '{', '}', '[', ']', ':', ',', ' ', '\t', '\n', '\r', '\f', '\v', '\0', '\u0001', '\u001f', '\u007f', '\u0085', ' ', ' ', '﻿', 'ä', 'a', '1', 'true', 'null', '\\u00e4', '\\u12', '\\n', '\\x', "'", '/']
    .map((piece) => Buffer.from(piece))
    .concat([Buffer.from([0xff]), Buffer.from([0xc3]), Buffer.from([0xed, 0xa0, 0x80])])

  const files = []
  for (let index = 0; index < 4000; index++) {
    let bytes = Buffer.from(pick(VALID))
    for (let change = 1 + random(3); change > 0; change--) {
      const at = random(bytes.length + 1)
      const kind = random(3)
      if (kind === 0) bytes = Buffer.concat([bytes.subarray(0, at), pick(PIECES), bytes.subarray(at)])
      else if (kind === 1) bytes = Buffer.concat([bytes.subarray(0, at), bytes.subarray(at + 1)])
      else bytes = Buffer.concat([bytes.subarray(0, at), pick(PIECES), bytes.subarray(at + 1)])
    }
    files.push(bytes)
  }

  const server = files.map(serverAccepts)
  // Enough of both kinds for the comparison to mean something.
  assert.ok(server.filter(Boolean).length > 300 && server.filter((accepted) => !accepted).length > 300)

  // The shell reads text as its locale says, so the check must hold with and without one.
  for (const environment of [{}, { LC_ALL: 'C' }]) {
    const script = scriptAccepts(files, environment)
    const wrong = files.filter((_bytes, index) => script[index] && !server[index])
    assert.deepEqual(wrong.map((bytes) => JSON.stringify(bytes.toString('latin1'))), [], 'passed the check, but pforte would not start with it')
    // And it is not stricter than it has to be where it matters: of the files in plain, visible characters it takes
    // exactly those pforte takes. (It refuses invisible characters at the ends, which pforte cuts off, control
    // characters in a value and bytes that are no text: nothing a file of headers has by intention.)
    const plain = files.map((bytes) => /^[\t\n\r\x20-\x7e]*$/.test(bytes.toString('latin1')) && bytes.toString('latin1').trim() !== '')
    assert.ok(plain.filter((isPlain, index) => isPlain && server[index]).length > 200)
    const refused = files.filter((_bytes, index) => plain[index] && server[index] && !script[index])
    assert.deepEqual(refused.map((bytes) => JSON.stringify(bytes.toString('latin1'))), [], 'pforte takes it, the check does not')
  }
})

// --- The script as a whole, in its check mode, in a copy of the folder with made-up settings. `docker` is a
// stand-in that does nothing: these tests are about what happens before Docker is asked.

const SECRET_URL = 'https://account:url-password@sms.example.com/send?key=url-key'
/** `headers: null` leaves the file out. `branding` are the files of a folder `branding` next to the script. */
const installation = ({ sms = true, headers = '{"X-Api-Key":"header-key"}', extra = '', branding } = {}) => {
  const root = mkdtempSync(join(temporary, 'checkout-'))
  const folder = join(root, 'examples', 'swarm')
  mkdirSync(join(folder, 'secrets'), { recursive: true })
  for (const file of ['deploy.sh', 'stack.yml', 'stack.app.yml', 'stack.sms.yml', 'stack.branding.yml']) cpSync(join(swarm, file), join(folder, file))
  for (const secret of ['db_password', 'cookie_keys', 'jwks', 'smtp_url']) writeFileSync(join(folder, 'secrets', secret), 'x')
  writeFileSync(join(folder, 'secrets', 'database_url'), 'postgres://pforte:x@pforte_db:5432/pforte')
  if (headers !== null) writeFileSync(join(folder, 'secrets', 'sms_headers'), headers)
  for (const [file, content] of Object.entries(branding ?? {})) {
    mkdirSync(join(folder, 'branding', file, '..'), { recursive: true })
    writeFileSync(join(folder, 'branding', file), content)
  }
  const settings = ['PFORTE_HOST=id.example.com', 'PFORTE_IMAGE=ghcr.io/progwise/pforte:0.2.0', 'MAIL_FROM=no-reply@example.com', 'DATA_DIR=/srv/pforte']
  if (sms) settings.push('SMS_PROVIDER=http', `SMS_URL='${SECRET_URL}'`, 'SMS_CONTENT_TYPE=form', "SMS_BODY='to={{to}}&text={{ text }}'")
  writeFileSync(join(folder, '.env'), `${settings.join('\n')}\n${extra}\n`)

  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'docker'), 0o755)
  const git = (...parameters) => spawnSync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...parameters])
  git('init', '--quiet')
  git('commit', '--quiet', '--allow-empty', '--message', 'test')

  const result = spawnSync('bash', [join(folder, 'deploy.sh'), '--check'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
  return { status: result.status, output: result.stdout + result.stderr }
}

test('without SMS settings the check says nothing about SMS', () => {
  const { status, output } = installation({ sms: false, headers: null })
  assert.equal(status, 0, output)
  assert.doesNotMatch(output, /SMS/)
})

test('with SMS settings the check says that SMS is on, and nothing of the address', () => {
  const { status, output } = installation()
  assert.equal(status, 0, output)
  assert.match(output, /^SMS: +on$/m)
  assert.doesNotMatch(output, /sms\.example\.com|url-password|url-key|account|header-key/)
})

test('SMS settings without the file of the headers are refused', () => {
  const { status, output } = installation({ headers: null })
  assert.equal(status, 1)
  assert.match(output, /secrets\/sms_headers is missing or empty/)
})

test('headers that pforte would not start with are refused, and not shown', () => {
  for (const headers of ['{"X-Api-Key":"header-key"}}', '["header-key"]', '{"X-Api-Key":\f"header-key"}']) {
    const { status, output } = installation({ headers })
    assert.equal(status, 1, output)
    assert.match(output, /secrets\/sms_headers is not a JSON object whose values are all strings/)
    assert.doesNotMatch(output, /header-key|valid\. Nothing was deployed/)
  }
})

test('headers in .env are refused: they would be part of the service definition', () => {
  const { status, output } = installation({ extra: `SMS_HEADERS='{"X-Api-Key":"header-key"}'` })
  assert.equal(status, 1)
  assert.match(output, /SMS_HEADERS is set in \.env/)
  assert.doesNotMatch(output, /header-key/)
})

// --- A branding folder: on the machine the script runs on, copied to the node under a name made from its content.

const fingerprintOf = (output) => /^Branding: +branding +\(on the node: \/srv\/pforte\/branding\/([0-9a-f]{12})\)$/m.exec(output)?.[1]

test('without a branding folder the check says nothing about branding', () => {
  const { status, output } = installation({ sms: false, headers: null })
  assert.equal(status, 0, output)
  assert.doesNotMatch(output, /[Bb]randing/)
})

test('a branding folder that is not there is refused', () => {
  const { status, output } = installation({ sms: false, headers: null, extra: 'BRANDING_DIR=branding' })
  assert.equal(status, 1)
  assert.match(output, /there is no folder "branding" on this machine/)
})

test('a branding folder is named on the node after what is in it: the same again for the same files, another for a change', () => {
  const brand = { 'brand.json': '{"name":"Example Inc.","logo":"logo.svg"}', 'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'locales/de.json': '{}' }
  const check = (branding) => {
    const { status, output } = installation({ sms: false, headers: null, extra: 'BRANDING_DIR=branding', branding })
    assert.equal(status, 0, output)
    const fingerprint = fingerprintOf(output)
    assert.ok(fingerprint, output)
    return fingerprint
  }
  const first = check(brand)
  assert.equal(check(brand), first)
  assert.equal(check({ ...brand, '.DS_Store': 'what a file manager leaves behind' }), first)
  // A changed content, a renamed file and a file in a subfolder each make another folder, so pforte restarts with it.
  assert.notEqual(check({ ...brand, 'brand.json': '{"name":"Example Ltd.","logo":"logo.svg"}' }), first)
  assert.notEqual(check({ 'brand.json': brand['brand.json'], 'mark.svg': brand['logo.svg'], 'locales/de.json': '{}' }), first)
  assert.notEqual(check({ ...brand, 'locales/fr.json': '{}' }), first)
})
