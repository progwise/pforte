import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRecordingNotifier } from '../test/recording-notifier.js'
import { createTestDatabase } from '@progwise/pforte-db/testing'
import { bootstrapAdministrator } from './bootstrap.js'

describe.skipIf(!hasDatabase)('setting up the first administrator at start', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>
  const recording = createRecordingNotifier()

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  afterAll(async () => {
    await database?.drop()
  })

  it('mails the activation link of pforte itself, and reports what it did without the link', async () => {
    const message = await bootstrapAdministrator({ db: database.db, email: 'boss@example.com', notifier: recording.notifier, issuer: 'https://id.example.com' })

    expect(message).toBe('boss@example.com was created as the first administrator (BOOTSTRAP_ADMIN_EMAIL). The link to choose a password was sent to that address.')
    expect(recording.notifications).toEqual([expect.objectContaining({ kind: 'activation', user: expect.objectContaining({ email: 'boss@example.com' }) })])
    expect(recording.notifications[0]!.url).toMatch(/^https:\/\/id\.example\.com\/activate\?token=[\w-]{43}$/)
    expect(message).not.toContain('token=')
  })

  it('says nothing and sends nothing at the next start', async () => {
    recording.notifications.length = 0
    expect(await bootstrapAdministrator({ db: database.db, email: 'boss@example.com', notifier: recording.notifier, issuer: 'https://id.example.com' })).toBeUndefined()
    expect(recording.notifications).toEqual([])
  })
})
