import { type Config, loadConfig } from './config.js'
import { checkConfig, startupFailure } from './security/startup-checks.js'

/**
 * The settings, checked before anything is changed: a start that would be refused must not first migrate the database.
 * Throws with a message that says what to fix.
 */
export const checkSettings = (env: Record<string, string | undefined> = process.env): Config => {
  const config = loadConfig(env)
  if (config.production) {
    const problems = checkConfig(config)
    if (problems.length > 0) throw new Error(startupFailure(problems))
  }
  return config
}
