import { describe, expect, it } from 'vitest'
import { createSlugger, slugify } from './slug.js'

describe('heading ids', () => {
  it.each([
    ['Weak secrets stop a production start', 'weak-secrets-stop-a-production-start'],
    ['What a production start needs', 'what-a-production-start-needs'],
    ['Secrets from files (NAME_FILE)', 'secrets-from-files-name_file'],
    ['Per-client settings', 'per-client-settings'],
    ['Über die Sprache', 'über-die-sprache'],
    ['  Trimmed  ', 'trimmed'],
    ['A, B & C: "quoted"', 'a-b--c-quoted'],
  ])('are those of GitHub: %s', (heading, id) => {
    expect(slugify(heading)).toBe(id)
  })

  it('are made unique on a page the way GitHub does it', () => {
    const slug = createSlugger()

    expect([slug('Notes'), slug('Notes'), slug('Notes'), slug('Other')]).toEqual(['notes', 'notes-1', 'notes-2', 'other'])
  })
})
