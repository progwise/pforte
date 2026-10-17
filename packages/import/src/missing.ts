import type { ApiUser } from './api.js'
import { ImportFileError } from './errors.js'

export type MissingMode = 'ignore' | 'lock' | 'delete'

export interface MissingOptions {
  mode: MissingMode
  allowDelete: boolean
  /** Abort when more than this share of the non-admin users would be affected. */
  maxMissingPercent: number
  force: boolean
}

export interface MissingPlan {
  toLock: ApiUser[]
  toDelete: ApiUser[]
  /** Missing users the import leaves alone, with the reason (already locked, …). */
  skipped: { user: ApiUser; reason: string }[]
}

/**
 * Decides what happens to users who are not in the file. Nothing is changed here, so this can refuse
 * before the first write. Administrators are never touched, and the e-mail of a rejected row counts
 * as present. Refuses a file without a valid row, and a change that would hit more than the allowed
 * share of users (a truncated export is the usual cause).
 */
export const planMissing = (
  users: ApiUser[],
  presentEmails: Set<string>,
  validRows: number,
  { mode, allowDelete, maxMissingPercent, force }: MissingOptions,
): MissingPlan => {
  const none: MissingPlan = { toLock: [], toDelete: [], skipped: [] }
  if (mode === 'ignore') return none

  if (mode === 'delete' && !allowDelete) {
    throw new ImportFileError('--missing=delete removes users for good. Add --allow-delete to confirm, or use --missing=lock, which can be undone.')
  }
  if (validRows === 0) {
    throw new ImportFileError(
      `The file has no valid rows, so --missing=${mode} would affect every user. Nothing was changed. Check the file.`,
    )
  }

  const regular = users.filter((user) => !user.isAdmin)
  const missing = regular.filter((user) => !presentEmails.has(user.email.toLowerCase()))

  const plan: MissingPlan = { toLock: [], toDelete: [], skipped: [] }
  if (mode === 'lock') {
    for (const user of missing) {
      if (user.status === 'created' || user.status === 'active') plan.toLock.push(user)
      else plan.skipped.push({ user, reason: `already ${user.status}` })
    }
  } else {
    plan.toDelete.push(...missing)
  }

  const affected = plan.toLock.length + plan.toDelete.length
  const percent = regular.length === 0 ? 0 : (affected / regular.length) * 100
  if (percent > maxMissingPercent && !force) {
    throw new ImportFileError(
      `${affected} of ${regular.length} users (${percent.toFixed(1)}%) are not in the file and would be ${mode === 'lock' ? 'locked' : 'deleted'}, ` +
        `more than the allowed ${maxMissingPercent}%. A truncated or wrong export is the usual cause. Nothing was changed. ` +
        'Check the file, or raise --max-missing-percent, or confirm with --force.',
    )
  }
  return plan
}
