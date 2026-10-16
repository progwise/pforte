// Prepares everything for an OpenID conformance run: .env.conformance with fresh keys, a separate
// database, its tables, and the suite's clients and test user. Safe to run again; it prints new
// client secrets and a new test password every time. See docs/conformance.md.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
// `pnpm run` sets npm_execpath to the pnpm that started this script.
const pnpm = process.env.npm_execpath
if (!pnpm) {
  throw new Error('Run this through pnpm: pnpm conformance:setup')
}

// pnpm is a JavaScript file in some versions and a native executable in others.
const runPnpm = (args, options) =>
  /\.[cm]?js$/.test(pnpm) ? run(process.execPath, [pnpm, ...args], options) : run(pnpm, args, options)

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options })
  if (result.status !== 0) {
    throw new Error(`Failed: ${command} ${args.join(' ')}`)
  }
}

console.log('1/4 Environment file and keys')
run('node', ['scripts/dev-keys.mjs', '--file', '.env.conformance', '--example', '.env.conformance.example'])

console.log('\n2/4 Database pforte_conformance')
const createDatabase = `select 'create database pforte_conformance' where not exists (select from pg_database where datname = 'pforte_conformance')\\gexec\n`
run('docker', ['compose', '-f', 'compose.dev.yaml', 'exec', '-T', 'postgres', 'psql', '-U', 'pforte', '-d', 'postgres'], {
  input: createDatabase,
  stdio: ['pipe', 'inherit', 'inherit'],
})

console.log('\n3/4 Tables')
runPnpm(['--filter', '@progwise/pforte-db', 'db:migrate'], {
  env: { ...process.env, ENV_FILE: '.env.conformance' },
})

console.log('\n4/4 Suite clients and test user')
runPnpm(['--filter', '@progwise/pforte-db', 'db:seed:conformance'])
