import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cutRelease, entryOf } from './changelog.mjs'

const script = new URL('./changelog.mjs', import.meta.url).pathname
const CHANGELOG = `# Changelog

Intro text.

## Unreleased

### Added

- A new thing.

## 0.2.0 (2026-10-01)

### Fixed

- A fix with a . and (brackets).

## 0.1.0 (2026-09-01)

First.
`

test('entryOf finds the entry of a version, up to the next one', () => {
  assert.equal(entryOf(CHANGELOG, '0.2.0'), '### Fixed\n\n- A fix with a . and (brackets).')
  assert.equal(entryOf(CHANGELOG, '0.1.0'), 'First.')
  assert.equal(entryOf(CHANGELOG, 'Unreleased'), '### Added\n\n- A new thing.')
})

test('entryOf does not take 0.1 for 0.1.0, nor 0.1.0 for 10.1.0', () => {
  assert.throws(() => entryOf(CHANGELOG, '0.1'), /no entry/)
  assert.throws(() => entryOf(CHANGELOG, '10.1.0'), /no entry/)
  assert.throws(() => entryOf(CHANGELOG, '0x1x0'), /no entry/)
})

test('entryOf refuses a missing or an empty entry, so a release cannot go out without notes', () => {
  assert.throws(() => entryOf(CHANGELOG, '9.9.9'), /no entry "9.9.9"/)
  assert.throws(() => entryOf('## Unreleased\n\n## 0.1.0 (2026-09-01)\n\nFirst.\n', 'Unreleased'), /empty/)
})

test('cutRelease turns Unreleased into the version and opens a new Unreleased', () => {
  const result = cutRelease(CHANGELOG, '0.3.0', '2026-11-02')

  assert.match(result, /## Unreleased\n\n## 0.3.0 \(2026-11-02\)\n\n### Added\n\n- A new thing\./)
  assert.equal(entryOf(result, '0.3.0'), '### Added\n\n- A new thing.')
  assert.throws(() => entryOf(result, 'Unreleased'), /empty/)
  assert.equal(entryOf(result, '0.2.0'), entryOf(CHANGELOG, '0.2.0'))
})

test('cutRelease refuses nothing to release, a version that exists, and a malformed version or date', () => {
  assert.throws(() => cutRelease(cutRelease(CHANGELOG, '0.3.0', '2026-11-02'), '0.3.1', '2026-11-03'), /empty/)
  assert.throws(() => cutRelease(CHANGELOG, '0.2.0', '2026-11-02'), /already has an entry for 0.2.0/)
  assert.throws(() => cutRelease(CHANGELOG, 'v0.3.0', '2026-11-02'), /not a version/)
  assert.throws(() => cutRelease(CHANGELOG, '0.3', '2026-11-02'), /not a version/)
  assert.throws(() => cutRelease(CHANGELOG, '0.3.0', '2.11.2026'), /not a date/)
})

test('cutRelease accepts a pre-release version', () => {
  assert.equal(entryOf(cutRelease(CHANGELOG, '0.3.0-rc.1', '2026-11-02'), '0.3.0-rc.1'), '### Added\n\n- A new thing.')
})

test('the command line prints notes and exits with an error when there are none', () => {
  const directory = mkdtempSync(join(tmpdir(), 'changelog-'))
  try {
    const file = join(directory, 'CHANGELOG.md')
    writeFileSync(file, CHANGELOG)

    assert.equal(execFileSync('node', [script, 'notes', '0.1.0', file], { encoding: 'utf8' }), 'First.\n')
    const missing = spawnSync('node', [script, 'notes', '7.7.7', file], { encoding: 'utf8' })
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /no entry "7.7.7"/)

    execFileSync('node', [script, 'release', '0.3.0', '2026-11-02', file])
    assert.match(readFileSync(file, 'utf8'), /## 0\.3\.0 \(2026-11-02\)/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the changelog of the repository has something to release or a release entry at the top', () => {
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  const headings = [...changelog.matchAll(/^## (.+)$/gm)].map((match) => match[1])

  assert.equal(headings[0], 'Unreleased')
  assert.ok(headings.length >= 1)
})
