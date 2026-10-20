export const HELP = `pforte: a small OpenID Connect identity service

Usage:
  pforte [start]             Run the service (applies pending database migrations first,
                             unless MIGRATE_ON_START=false)
  pforte migrate             Apply pending database migrations and exit
  pforte keys [--dir <dir>] [--force]
                             Generate COOKIE_KEYS and JWKS for a new installation. Prints them
                             as lines for an environment file, or with --dir writes them as
                             files (cookie_keys, jwks.json) for COOKIE_KEYS_FILE and JWKS_FILE
  pforte --version           Show the version
  pforte --help              Show this help

Settings come from the environment; see docs/configuration.md.
`

export type Command =
  | { name: 'start'; migrate: boolean }
  | { name: 'migrate' }
  | { name: 'keys'; dir?: string; force: boolean }
  | { name: 'version' }
  | { name: 'help' }

export class UsageError extends Error {}

/** What was asked for on the command line and in the environment. Throws a `UsageError` that says what is wrong. */
export const parseCommand = (argv: string[], env: Record<string, string | undefined>): Command => {
  const [first = 'start', ...rest] = argv
  const noOptions = (name: string) => {
    if (rest.length > 0) throw new UsageError(`"${name}" takes no further arguments, got "${rest.join(' ')}".`)
  }

  switch (first) {
    case 'start': {
      noOptions('start')
      const setting = env.MIGRATE_ON_START?.trim()
      if (setting !== undefined && setting !== '' && setting !== 'true' && setting !== 'false') {
        throw new UsageError(`MIGRATE_ON_START must be true or false, got "${setting}".`)
      }
      return { name: 'start', migrate: setting !== 'false' }
    }
    case 'migrate':
      noOptions('migrate')
      return { name: 'migrate' }
    case 'keys': {
      let dir: string | undefined
      let force = false
      for (let index = 0; index < rest.length; index++) {
        const argument = rest[index]!
        if (argument === '--force') force = true
        else if (argument === '--dir') {
          dir = rest[++index]
          if (!dir) throw new UsageError('--dir needs a directory.')
        } else throw new UsageError(`Unknown option "${argument}" for "keys".`)
      }
      return { name: 'keys', dir, force }
    }
    case '--version':
    case '-v':
      return { name: 'version' }
    case '--help':
    case '-h':
    case 'help':
      return { name: 'help' }
    default:
      throw new UsageError(`Unknown command "${first}".`)
  }
}
