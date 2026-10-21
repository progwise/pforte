import { renderMarkdown, type Heading } from './markdown.js'
import { slugify } from './slug.js'

/** What the reference needs of an OpenAPI 3.1 document. Everything else in it is ignored. */
interface Schema {
  type?: string | string[]
  format?: string
  enum?: unknown[]
  description?: string
  default?: unknown
  pattern?: string
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
  additionalProperties?: Schema | boolean
  anyOf?: Schema[]
}
interface Parameter {
  name: string
  in: string
  required?: boolean
  description?: string
  schema?: Schema
}
interface Operation {
  tags?: string[]
  summary?: string
  description?: string
  parameters?: Parameter[]
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Schema }> }
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: Schema }> }>
  'x-required-scopes'?: string[]
}
export interface OpenApiDocument {
  info: { title: string; description?: string }
  tags?: { name: string; description?: string }[]
  paths: Record<string, Record<string, Operation>>
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
const ERROR_NAMES: Record<string, string> = {
  '400': 'invalid request',
  '401': 'unauthorized',
  '403': 'forbidden',
  '404': 'not found',
  '409': 'conflict',
  '429': 'too many requests',
  '503': 'unavailable',
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const code = (text: string) => `<code>${escapeHtml(text)}</code>`
const markdown = (text: string) => renderMarkdown(text, (href) => href).html

/** A schema as a short phrase: `string (uuid)`, `array of string`, `string or null`, `enum "a" | "b"`. */
export const typeOf = (schema: Schema): string => {
  if (schema.enum) return `enum ${schema.enum.map((value) => JSON.stringify(value)).join(' | ')}`
  if (schema.anyOf) return schema.anyOf.map(typeOf).join(' or ')
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : ['any']
  return types
    .map((type) => {
      if (type === 'array') return `array of ${schema.items ? typeOf(schema.items) : 'any'}`
      if (type === 'object') {
        return typeof schema.additionalProperties === 'object' && !schema.properties ? `map of ${typeOf(schema.additionalProperties)}` : 'object'
      }
      return schema.format ? `${type} (${schema.format})` : type
    })
    .join(' or ')
}

/** What limits a value, for the notes column. The long patterns of `uuid` and `email` are not shown: the format says it. */
const notesOf = (schema: Schema) => {
  const notes: string[] = []
  const range = (low: number | undefined, high: number | undefined, unit: string) =>
    low !== undefined && high !== undefined ? `${low} to ${high}${unit}` : high !== undefined ? `at most ${high}${unit}` : low !== undefined ? `at least ${low}${unit}` : ''
  if (schema.minLength !== undefined || schema.maxLength !== undefined) notes.push(schema.minLength === undefined ? `up to ${schema.maxLength} characters` : range(schema.minLength, schema.maxLength, ' characters'))
  if (schema.minimum !== undefined || schema.maximum !== undefined) notes.push(range(schema.minimum, schema.maximum, ''))
  if (schema.pattern && !schema.format) notes.push(`pattern ${schema.pattern}`)
  if (schema.default !== undefined) notes.push(`default ${JSON.stringify(schema.default)}`)
  return notes
}

interface Row {
  name: string
  type: string
  required: boolean
  description: string
  notes: string[]
}

/** The fields of an object schema, nested objects and arrays of objects with a path such as `user.email` or `items[].id`. */
export const rowsOf = (schema: Schema, prefix = ''): Row[] =>
  Object.entries(schema.properties ?? {}).flatMap(([name, property]) => {
    const path = `${prefix}${name}`
    const row: Row = { name: path, type: typeOf(property), required: schema.required?.includes(name) ?? false, description: property.description ?? '', notes: notesOf(property) }
    const nested = property.properties ? rowsOf(property, `${path}.`) : property.items?.properties ? rowsOf(property.items, `${path}[].`) : []
    return [row, ...nested]
  })

const table = (rows: Row[]) =>
  rows.length === 0
    ? ''
    : `<div class="table"><table>
<thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Notes</th></tr></thead>
<tbody>
${rows
  .map(
    (row) =>
      `<tr><td>${code(row.name)}</td><td>${escapeHtml(row.type)}</td><td>${row.required ? 'yes' : 'no'}</td><td>${row.description ? markdown(row.description).replace(/^<p>([\s\S]*)<\/p>\n?$/, '$1') : ''}${row.notes.length ? `${row.description ? '<br>' : ''}<small>${escapeHtml(row.notes.join('; '))}</small>` : ''}</td></tr>`,
  )
  .join('\n')}
</tbody></table></div>`

/** A body: a table of its fields; for a choice of shapes (`anyOf`), one table for each. */
const bodyTables = (schema: Schema | undefined): string => {
  if (!schema) return ''
  if (schema.anyOf) {
    return schema.anyOf.map((variant, index) => `<p class="variant">Shape ${index + 1} of ${schema.anyOf!.length}</p>\n${bodyTables(variant)}`).join('\n')
  }
  if (schema.properties) return table(rowsOf(schema))
  return `<p>${escapeHtml(typeOf(schema))}</p>`
}

const parameterTable = (parameters: Parameter[]) =>
  `<div class="table"><table>
<thead><tr><th>Name</th><th>In</th><th>Type</th><th>Required</th><th>Notes</th></tr></thead>
<tbody>
${parameters
  .map((parameter) => {
    const schema = parameter.schema ?? {}
    const notes = notesOf(schema)
    const description = parameter.description ? markdown(parameter.description).replace(/^<p>([\s\S]*)<\/p>\n?$/, '$1') : ''
    return `<tr><td>${code(parameter.name)}</td><td>${escapeHtml(parameter.in)}</td><td>${escapeHtml(typeOf(schema))}</td><td>${parameter.required ? 'yes' : 'no'}</td><td>${description}${notes.length ? `${description ? '<br>' : ''}<small>${escapeHtml(notes.join('; '))}</small>` : ''}</td></tr>`
  })
  .join('\n')}
</tbody></table></div>`

export const operationId = (method: string, path: string) =>
  `${method}-${path.replace(/^\/admin\//, '').replace(/[{}]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`

const json = (content: Record<string, { schema?: Schema }> | undefined) => content?.['application/json']?.schema

const renderOperation = (method: string, path: string, operation: Operation) => {
  const scopes = operation['x-required-scopes'] ?? []
  const responses = Object.entries(operation.responses ?? {})
  const successes = responses.filter(([status]) => status.startsWith('2'))
  const errors = responses.filter(([status]) => !status.startsWith('2'))
  const body = json(operation.requestBody?.content)

  return `<section class="operation" id="${operationId(method, path)}-section">
<h3 id="${operationId(method, path)}"><span class="method ${method}">${method.toUpperCase()}</span> <code>${escapeHtml(path)}</code></h3>
<p class="summary"><strong>${escapeHtml(operation.summary ?? '')}</strong></p>
${scopes.length ? `<p class="scopes">Needs the scope ${scopes.map(code).join(' or ')}.</p>` : ''}
${operation.description ? markdown(operation.description) : ''}
${operation.parameters?.length ? `<h4>Parameters</h4>\n${parameterTable(operation.parameters)}` : ''}
${body ? `<h4>Request body${operation.requestBody?.required ? '' : ' (optional)'}</h4>\n${bodyTables(body)}` : ''}
<h4>Responses</h4>
<ul>
${successes
  .map(([status, response]) => {
    const schema = json(response.content)
    const description = response.description && response.description !== 'Default Response' ? response.description : status === '204' ? 'No content' : 'Success'
    return `<li><strong>${status}</strong> ${escapeHtml(description)}${schema ? `\n<details><summary>Body</summary>\n${bodyTables(schema)}\n</details>` : ''}</li>`
  })
  .join('\n')}
${errors.length ? `<li>${errors.map(([status]) => `<strong>${status}</strong> ${escapeHtml(ERROR_NAMES[status] ?? '')}`).join(', ')}: a problem document (<code>application/problem+json</code>)</li>` : ''}
</ul>
</section>`
}

export interface RenderedReference {
  title: string
  html: string
  headings: Heading[]
  summary: string
}

/** The reference of the admin API: one section per tag, one block per operation, made from the OpenAPI document alone. */
export const renderOpenApi = (document: OpenApiDocument): RenderedReference => {
  const title = 'Admin API reference'
  const headings: Heading[] = [{ level: 1, text: title, id: slugify(title) }]
  const parts: string[] = [`<h1 id="${slugify(title)}">${title}</h1>`]

  const intro = renderMarkdown(
    `${document.info.description ?? ''}\n\nThe base address is the address of your pforte with \`/admin\` in front of the paths below, for example \`https://id.example.com/admin/users\`. This reference is made from [openapi.json](openapi.json), which describes the same API for tools.`,
    (href) => href,
  )
  parts.push(intro.html)

  const tags = document.tags ?? []
  const operations = Object.entries(document.paths).flatMap(([path, item]) => METHODS.filter((method) => item[method]).map((method) => ({ method, path, operation: item[method]! })))
  const names = [...tags.map((tag) => tag.name), ...new Set(operations.flatMap((entry) => entry.operation.tags ?? []).filter((name) => !tags.some((tag) => tag.name === name)))]
  // An operation without a tag must not vanish from the reference.
  if (operations.some((entry) => !entry.operation.tags?.length)) names.push('Other')

  for (const name of names) {
    const inTag = operations.filter((entry) => (entry.operation.tags?.length ? entry.operation.tags.includes(name) : name === 'Other'))
    if (inTag.length === 0) continue
    const id = slugify(name)
    headings.push({ level: 2, text: name, id })
    parts.push(`<h2 id="${id}">${escapeHtml(name)}</h2>`)
    const description = tags.find((tag) => tag.name === name)?.description
    if (description) parts.push(`<p>${escapeHtml(description)}</p>`)
    parts.push(
      `<ul class="operations">${inTag.map((entry) => `<li><a href="#${operationId(entry.method, entry.path)}"><span class="method ${entry.method}">${entry.method.toUpperCase()}</span> ${escapeHtml(entry.path.replace(/^\/admin/, ''))}</a> ${escapeHtml(entry.operation.summary ?? '')}</li>`).join('\n')}</ul>`,
    )
    for (const entry of inTag) {
      headings.push({ level: 3, text: `${entry.method.toUpperCase()} ${entry.path}`, id: operationId(entry.method, entry.path) })
      parts.push(renderOperation(entry.method, entry.path, entry.operation))
    }
  }

  return { title, html: parts.join('\n'), headings, summary: intro.summary }
}
