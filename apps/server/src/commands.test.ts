import { describe, expect, it } from 'vitest'
import { HELP, parseCommand, UsageError } from './commands.js'

describe('the commands of pforte', () => {
  it('starts the service by default, applying migrations first', () => {
    expect(parseCommand([], {})).toEqual({ name: 'start', migrate: true })
    expect(parseCommand(['start'], {})).toEqual({ name: 'start', migrate: true })
  })

  it('does not migrate at start when told not to', () => {
    expect(parseCommand([], { MIGRATE_ON_START: 'false' })).toEqual({ name: 'start', migrate: false })
    expect(parseCommand([], { MIGRATE_ON_START: 'true' })).toEqual({ name: 'start', migrate: true })
    expect(parseCommand([], { MIGRATE_ON_START: '' })).toEqual({ name: 'start', migrate: true })
  })

  it('refuses a setting that is neither true nor false, instead of guessing', () => {
    expect(() => parseCommand([], { MIGRATE_ON_START: '0' })).toThrow(/MIGRATE_ON_START must be true or false, got "0"/)
    expect(() => parseCommand([], { MIGRATE_ON_START: 'no' })).toThrow(UsageError)
  })

  it('migrates on its own', () => {
    expect(parseCommand(['migrate'], { MIGRATE_ON_START: 'false' })).toEqual({ name: 'migrate' })
  })

  it('generates keys, to the screen or into a directory', () => {
    expect(parseCommand(['keys'], {})).toEqual({ name: 'keys', dir: undefined, force: false })
    expect(parseCommand(['keys', '--dir', '/secrets'], {})).toEqual({ name: 'keys', dir: '/secrets', force: false })
    expect(parseCommand(['keys', '--force', '--dir', '/secrets'], {})).toEqual({ name: 'keys', dir: '/secrets', force: true })
  })

  it('says what is wrong with the arguments', () => {
    expect(() => parseCommand(['keys', '--dir'], {})).toThrow('--dir needs a directory.')
    expect(() => parseCommand(['keys', '--out'], {})).toThrow('Unknown option "--out" for "keys".')
    expect(() => parseCommand(['migrate', 'now'], {})).toThrow('"migrate" takes no further arguments, got "now".')
    expect(() => parseCommand(['explode'], {})).toThrow('Unknown command "explode".')
  })

  it('shows the version and the help', () => {
    expect(parseCommand(['--version'], {})).toEqual({ name: 'version' })
    expect(parseCommand(['--help'], {})).toEqual({ name: 'help' })
    expect(parseCommand(['help'], {})).toEqual({ name: 'help' })
    for (const word of ['start', 'migrate', 'keys', 'MIGRATE_ON_START']) expect(HELP).toContain(word)
  })
})
