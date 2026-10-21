import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { operationId, renderOpenApi, rowsOf, typeOf, type OpenApiDocument } from './openapi.js'

const document: OpenApiDocument = {
  info: { title: 'Test API', description: 'Talks **JSON**. Errors are problem documents.' },
  tags: [{ name: 'Users', description: 'The people.' }],
  paths: {
    '/admin/users/by-email/{email}': {
      put: {
        tags: ['Users'],
        summary: 'Create or update a user',
        description: 'Idempotent.\n\nWith `dryRun=true` nothing is written.',
        'x-required-scopes': ['directory', 'admin'],
        parameters: [
          { name: 'email', in: 'path', required: true, schema: { type: 'string', format: 'email', pattern: '^long-email-pattern$' } },
          { name: 'dryRun', in: 'query', required: false, schema: { type: 'string', enum: ['true', 'false'], default: 'false' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['firstName'],
                properties: {
                  firstName: { type: 'string', minLength: 1, maxLength: 200, description: 'The given name.' },
                  phone: { type: ['string', 'null'], description: 'Like `+4915112345678`.' },
                  claims: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Default Response',
            content: {
              'application/json': {
                schema: {
                  anyOf: [
                    { type: 'object', required: ['outcome'], properties: { outcome: { type: 'string', enum: ['updated', 'unchanged'] } } },
                    { type: 'object', properties: { changes: { type: 'object', properties: { profile: { type: 'object', additionalProperties: true } } } } },
                  ],
                },
              },
            },
          },
          '201': { description: 'Default Response' },
          '400': { description: 'x' },
          '401': { description: 'x' },
          '409': { description: 'x' },
        },
      },
    },
    '/admin/users/{id}': { delete: { tags: ['Users'], summary: 'Delete a user', 'x-required-scopes': ['admin'], responses: { '204': { description: 'Default Response' }, '404': { description: 'x' } } } },
  },
}

describe('describing a schema', () => {
  it('names types the way a reader would', () => {
    expect(typeOf({ type: 'string' })).toBe('string')
    expect(typeOf({ type: 'string', format: 'uuid' })).toBe('string (uuid)')
    expect(typeOf({ type: ['string', 'null'] })).toBe('string or null')
    expect(typeOf({ type: 'array', items: { type: 'string' } })).toBe('array of string')
    expect(typeOf({ type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } })).toBe('map of array of string')
    expect(typeOf({ type: 'string', enum: ['a', 'b'] })).toBe('enum "a" | "b"')
    expect(typeOf({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toBe('string or number')
  })

  it('lists the fields of nested objects and arrays of objects with their path', () => {
    const rows = rowsOf({
      type: 'object',
      required: ['user'],
      properties: {
        user: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, email: { type: 'string' } } },
        items: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' } } } },
      },
    })

    expect(rows.map((row) => [row.name, row.required])).toEqual([['user', true], ['user.id', true], ['user.email', false], ['items', false], ['items[].key', false]])
  })
})

describe('the reference made from a document', () => {
  const reference = renderOpenApi(document)

  it('has a title, the description of the API, and a section for each tag with its operations', () => {
    expect(reference.title).toBe('Admin API reference')
    expect(reference.html).toContain('<strong>JSON</strong>')
    expect(reference.html).toContain('<h2 id="users">Users</h2>')
    expect(reference.headings.map((heading) => [heading.level, heading.id])).toEqual([[1, 'admin-api-reference'], [2, 'users'], [3, 'put-users-by-email-email'], [3, 'delete-users-id']])
  })

  it('names the method, the path and the scopes an operation needs', () => {
    expect(reference.html).toContain('<span class="method put">PUT</span> <code>/admin/users/by-email/{email}</code>')
    expect(reference.html).toContain('Needs the scope <code>directory</code> or <code>admin</code>.')
    expect(reference.html).toContain('Needs the scope <code>admin</code>.')
  })

  it('lists parameters and the request body, and leaves out the long patterns of formats', () => {
    expect(reference.html).toMatch(/<td><code>email<\/code><\/td><td>path<\/td><td>string \(email\)<\/td><td>yes<\/td>/)
    expect(reference.html).not.toContain('long-email-pattern')
    expect(reference.html).toContain('default &quot;false&quot;')
    expect(reference.html).toContain('<h4>Request body</h4>')
    expect(reference.html).toMatch(/<code>firstName<\/code><\/td><td>string<\/td><td>yes<\/td>/)
    expect(reference.html).toContain('1 to 200 characters')
    expect(reference.html).toContain('<code>+4915112345678</code>')
  })

  it('shows a choice of answers as separate shapes, and the errors in one line', () => {
    expect(reference.html).toContain('Shape 1 of 2')
    expect(reference.html).toContain('Shape 2 of 2')
    expect(reference.html).toContain('<strong>400</strong> invalid request, <strong>401</strong> unauthorized, <strong>409</strong> conflict')
    expect(reference.html).toContain('<strong>204</strong> No content')
    expect(reference.html).not.toContain('Default Response')
  })

  it('escapes what the document says', () => {
    const hostile = renderOpenApi({ info: { title: 'x' }, paths: { '/admin/x': { get: { summary: '<script>alert(1)</script>', responses: { '200': { description: '<b>' } } } } } })

    expect(hostile.html).not.toContain('<script>')
    expect(hostile.html).toContain('&lt;script&gt;')
  })

  it('keeps an operation without a tag in a section of its own', () => {
    const untagged = renderOpenApi({ info: { title: 'x' }, paths: { '/admin/x': { get: { summary: 'No tag', responses: { '200': { description: 'ok' } } } } } })

    expect(untagged.html).toContain('<h2 id="other">Other</h2>')
    expect(untagged.html).toContain('No tag')
  })

  it('makes the same anchors for the same operation', () => {
    expect(operationId('put', '/admin/users/{id}/claims/{type}')).toBe('put-users-id-claims-type')
  })
})

describe('the real admin API', () => {
  const real = JSON.parse(readFileSync(fileURLToPath(new URL('../../docs/openapi.json', import.meta.url)), 'utf8')) as OpenApiDocument
  const reference = renderOpenApi(real)
  const operations = Object.values(real.paths).flatMap((item) => Object.keys(item))

  it('has every operation in the reference, each with the scopes it needs', () => {
    expect((reference.html.match(/class="operation"/g) ?? []).length).toBe(operations.length)
    expect((reference.html.match(/Needs the scope/g) ?? []).length).toBe(operations.length)
    expect(reference.headings.filter((heading) => heading.level === 3)).toHaveLength(operations.length)
  })

  it('has no two operations with the same anchor', () => {
    const ids = reference.headings.map((heading) => heading.id)

    expect(new Set(ids).size).toBe(ids.length)
  })

  it('describes the upsert by e-mail, which the page on syncing users is about', () => {
    expect(reference.html).toContain('<code>/admin/users/by-email/{email}</code>')
    expect(reference.html).toContain('Idempotent')
  })
})
