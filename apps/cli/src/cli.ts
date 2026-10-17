#!/usr/bin/env -S npx tsx
import { readFile, writeFile } from 'node:fs/promises'
import { runCli } from './main.js'

const exitCode = await runCli(process.argv.slice(2), process.env, {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(text),
  interactive: Boolean(process.stderr.isTTY),
  readFile,
  // The report and the rejected rows hold personal data: readable by the owner only.
  writeFile: (path, content) => writeFile(path, content, { mode: 0o600 }),
})

process.exitCode = exitCode
