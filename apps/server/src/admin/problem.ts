import type { FastifyReply } from 'fastify'
import { z } from 'zod'

/** The shape of every error of the admin API (RFC 9457). Also used in the OpenAPI document. */
export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string().optional(),
  /** For validation errors: which fields are wrong. */
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
})

/** Sends an error as RFC 9457 `application/problem+json`. */
export const problem = (
  reply: FastifyReply,
  status: number,
  title: string,
  detail?: string,
  headers: Record<string, string> = {},
  extra: Record<string, unknown> = {},
) =>
  reply
    .code(status)
    .headers(headers)
    .type('application/problem+json')
    .send({ type: 'about:blank', title, status, ...(detail ? { detail } : {}), ...extra })
