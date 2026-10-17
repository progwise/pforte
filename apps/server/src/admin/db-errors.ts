/** True for a Postgres unique violation, however deeply the driver wrapped it. */
export const isUniqueViolation = (error: unknown): boolean => {
  const candidate = error as { code?: string; cause?: unknown } | undefined
  return candidate?.code === '23505' || (candidate?.cause !== undefined && isUniqueViolation(candidate.cause))
}
