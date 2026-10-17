export interface Problem {
  /** JSON pointer to the offending part of the request, e.g. `/claims/partner_no`. */
  path: string
  message: string
}

/**
 * A change the admin API cannot apply. `invalid`: the request is wrong; `conflict`: it is valid but
 * not possible in the current state; `not_found`: something it refers to does not exist.
 */
export class AdminError extends Error {
  constructor(
    message: string,
    readonly kind: 'invalid' | 'conflict' | 'not_found',
    readonly problems: Problem[] = [],
  ) {
    super(message)
  }
}
