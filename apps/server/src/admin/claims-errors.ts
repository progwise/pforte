import { ClaimsError } from '@progwise/pforte-db/admin'
import type { FastifyReply } from 'fastify'
import { problem } from './problem.js'

const TITLES = { invalid: 'Invalid claims', conflict: 'Conflict', not_found: 'Not found' } as const
const STATUS = { invalid: 400, conflict: 409, not_found: 404 } as const

/** Turns a `ClaimsError` into a problem document: 400 invalid, 409 conflict, 404 not found. */
export const sendClaimsError = (reply: FastifyReply, error: ClaimsError) =>
  problem(reply, STATUS[error.kind], TITLES[error.kind], error.message, {}, error.problems.length ? { errors: error.problems } : {})

/** Runs a handler and answers a `ClaimsError` thrown by it; anything else is rethrown. */
export const answeringClaimsErrors = async <T>(reply: FastifyReply, run: () => Promise<T>) => {
  try {
    return await run()
  } catch (error) {
    if (error instanceof ClaimsError) return sendClaimsError(reply, error)
    throw error
  }
}
