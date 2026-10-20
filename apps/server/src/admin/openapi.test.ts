import { hasDatabase } from '@progwise/pforte-db/testing'
import SwaggerParser from '@apidevtools/swagger-parser'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AdminHarness, createAdminHarness, ISSUER } from '../test/admin-harness.js'

/** Every operation of the admin API. Adding or removing a route means updating this list on purpose. */
const OPERATIONS = [
  'DELETE /admin/claim-types/{key}',
  'DELETE /admin/clients/{clientId}',
  'DELETE /admin/users/{id}',
  'DELETE /admin/users/{id}/claims/{type}/{value}',
  'DELETE /admin/users/{id}/devices',
  'DELETE /admin/users/{id}/devices/{deviceId}',
  'GET /admin/audit-events',
  'GET /admin/claim-types',
  'GET /admin/clients',
  'GET /admin/clients/{clientId}',
  'GET /admin/clients/{clientId}/claim-types',
  'GET /admin/users',
  'GET /admin/users/{id}',
  'GET /admin/users/{id}/claims',
  'GET /admin/users/{id}/devices',
  'GET /admin/users/{id}/sessions',
  'GET /admin/whoami',
  'PATCH /admin/claim-types/{key}',
  'PATCH /admin/clients/{clientId}',
  'PATCH /admin/users/{id}',
  'POST /admin/claim-types',
  'POST /admin/clients',
  'POST /admin/clients/{clientId}/rotate-secret',
  'POST /admin/users',
  'POST /admin/users/{id}/activate',
  'POST /admin/users/{id}/claims/{type}',
  'POST /admin/users/{id}/deactivate',
  'POST /admin/users/{id}/end-sessions',
  'POST /admin/users/{id}/lock',
  'POST /admin/users/{id}/reset-password',
  'POST /admin/users/{id}/unlock',
  'PUT /admin/clients/{clientId}/claim-types',
  'PUT /admin/users/by-email/{email}',
  'PUT /admin/users/{id}/claims',
  'PUT /admin/users/{id}/claims/{type}',
]

describe.skipIf(!hasDatabase)('admin API: OpenAPI document', () => {
  let h: AdminHarness
  let document: Record<string, any>

  beforeAll(async () => {
    h = await createAdminHarness()
    const response = await h.api('GET', '/openapi.json')
    expect(response.statusCode).toBe(200)
    document = response.json()
  })

  afterAll(async () => {
    await h?.close()
  })

  const operations = () =>
    Object.entries<Record<string, any>>(document.paths).flatMap(([path, item]) =>
      Object.entries(item).map(([method, operation]) => ({ id: `${method.toUpperCase()} ${path}`, operation })),
    )

  it('needs a token, but any admin API client may read it', async () => {
    expect((await h.api('GET', '/openapi.json', { token: null })).statusCode).toBe(401)
    expect((await h.api('GET', '/openapi.json', { token: h.directoryToken })).statusCode).toBe(200)
  })

  it('is valid OpenAPI 3.1', async () => {
    expect(document.openapi).toBe('3.1.0')

    // The parser rewrites what it validates, so give it a copy.
    await expect(SwaggerParser.validate(structuredClone(document) as never)).resolves.toBeDefined()
  })

  it('describes the service and how to authenticate', () => {
    expect(document.info.title).toBe('pforte admin API')
    expect(document.servers).toEqual([{ url: ISSUER }])
    expect(document.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' })
    expect(document.security).toEqual([{ bearerAuth: [] }])
  })

  it('lists exactly the operations the API has', () => {
    expect(operations().map(({ id }) => id).sort()).toEqual(OPERATIONS)
  })

  it('documents every operation: a tag, a summary, a success response and the error responses', () => {
    for (const { id, operation } of operations()) {
      expect(operation.tags?.length, `${id} has a tag`).toBeGreaterThan(0)
      expect(operation.summary, `${id} has a summary`).toBeTruthy()
      const statuses = Object.keys(operation.responses)
      expect(statuses.some((status) => status.startsWith('2')), `${id} documents a success response`).toBe(true)
      expect(statuses, `${id} documents 401`).toContain('401')
    }
  })

  it('describes errors as problem documents', () => {
    const problem = document.paths['/admin/users'].post.responses['409']

    expect(problem.content['application/problem+json'] ?? problem.content['application/json']).toBeDefined()
  })

  it('never mentions a secret, hash or token field of the database', () => {
    const text = JSON.stringify(document)

    expect(text).not.toMatch(/secretHash|passwordHash|activationTokenHash|password_hash|secret_hash/)
  })

  it('shows the secret only where it is returned once', () => {
    const created = JSON.stringify(document.paths['/admin/clients'].post.responses['201'])
    const read = JSON.stringify(document.paths['/admin/clients/{clientId}'].get.responses['200'])

    expect(created).toContain('clientSecret')
    expect(read).not.toContain('clientSecret')
  })
})
