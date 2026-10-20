// Reads and changes CHANGELOG.md.
//   node scripts/changelog.mjs notes <version> [file]        prints the entry of a version (or "Unreleased")
//   node scripts/changelog.mjs release <version> <date> [file]
//                                                            turns "Unreleased" into the entry of the version and
//                                                            opens a new, empty "Unreleased"
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The text under `## <heading>`, up to the next `## ` heading, without blank lines around it. */
export const entryOf = (changelog, heading) => {
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp(`^## ${escape(heading)}( |$)`).test(line))
  if (start === -1) throw new Error(`The changelog has no entry "${heading}".`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  const text = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
  if (text === '') throw new Error(`The changelog entry "${heading}" is empty.`)
  return text
}

/** The changelog with "Unreleased" turned into the entry of the version, and a new "Unreleased" above it. */
export const cutRelease = (changelog, version, date) => {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new Error(`"${version}" is not a version such as 0.1.0.`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`"${date}" is not a date such as 2026-11-02.`)
  if (new RegExp(`^## ${escape(version)}( |$)`, 'm').test(changelog)) throw new Error(`The changelog already has an entry for ${version}.`)
  entryOf(changelog, 'Unreleased') // refuses when there is nothing to release
  return changelog.replace(/^## Unreleased[ \t]*$/m, `## Unreleased\n\n## ${version} (${date})`)
}

const main = () => {
  const [command, ...args] = process.argv.slice(2)
  const fail = (message) => {
    console.error(message)
    process.exit(1)
  }
  try {
    if (command === 'notes') {
      const [version, file = 'CHANGELOG.md'] = args
      if (!version) fail('Usage: changelog.mjs notes <version> [file]')
      process.stdout.write(`${entryOf(readFileSync(file, 'utf8'), version === 'Unreleased' ? 'Unreleased' : version)}\n`)
    } else if (command === 'release') {
      const [version, date, file = 'CHANGELOG.md'] = args
      if (!version || !date) fail('Usage: changelog.mjs release <version> <date> [file]')
      writeFileSync(file, cutRelease(readFileSync(file, 'utf8'), version, date))
    } else {
      fail('Usage: changelog.mjs notes <version> | release <version> <date>')
    }
  } catch (error) {
    fail(error.message)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
