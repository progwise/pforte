import { AdminError } from '@progwise/pforte-db/admin'
import type { FastifyReply } from 'fastify'
import { problem } from './problem.js'

const TITLES = { invalid: 'Invalid request', conflict: 'Conflict', not_found: 'Not found' } as const
const STATUS = { invalid: 400, conflict: 409, not_found: 404 } as const

/** Turns an `AdminError` into a problem document: 400 invalid, 409 conflict, 404 not found. */
export const sendAdminError = (reply: FastifyReply, error: AdminError) =>
  problem(reply, STATUS[error.kind], TITLES[error.kind], error.message, {}, error.problems.length ? { errors: error.problems } : {})

/** Runs a handler and answers an `AdminError` thrown by it; anything else is rethrown. */
export const answeringAdminErrors = async <T>(reply: FastifyReply, run: () => Promise<T>) => {
  try {
    return await run()
  } catch (error) {
    if (error instanceof AdminError) return sendAdminError(reply, error)
    throw error
  }
}
