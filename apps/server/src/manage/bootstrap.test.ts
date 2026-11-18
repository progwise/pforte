import { hasDatabase } from '@progwise/pforte-db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRecordingNotifier } from '../test/recording-notifier.js'
import { createTestDatabase } from '@progwise/pforte-db/testing'
import { bootstrapAdministrator } from './bootstrap.js'
import { ensureAdminUiClient } from './setup.js'

describe.skipIf(!hasDatabase)('setting up the first administrator at start', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>
  const recording = createRecordingNotifier()

  beforeAll(async () => {
    database = await createTestDatabase()
    await ensureAdminUiClient(database.db, 'https://id.example.com')
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

  it('makes that link work for as long as the installation says', async () => {
    const other = await createTestDatabase()
    const sent = createRecordingNotifier()
    try {
      await ensureAdminUiClient(other.db, 'https://id.example.com')
      await bootstrapAdministrator({ db: other.db, email: 'boss@example.com', notifier: sent.notifier, issuer: 'https://id.example.com', activationValidityMs: 2 * 86_400_000 })
      expect((sent.notifications[0]!.expiresAt!.getTime() - Date.now()) / 86_400_000).toBeCloseTo(2, 2)
    } finally {
      await other.drop()
    }
  })

  it('says what the account is for, and has the page after choosing the password lead on to the administration', async () => {
    expect(recording.notifications[0]!.applicationName).toBe('Administration')
    const { rows } = await database.pool.query(`select u.activation_client_id, c.client_uri from users u join clients c on c.client_id = u.activation_client_id`)
    expect(rows).toEqual([{ activation_client_id: 'pforte-admin-ui', client_uri: 'https://id.example.com/manage' }])
  })

  it('says nothing and sends nothing at the next start', async () => {
    recording.notifications.length = 0
    expect(await bootstrapAdministrator({ db: database.db, email: 'boss@example.com', notifier: recording.notifier, issuer: 'https://id.example.com' })).toBeUndefined()
    expect(recording.notifications).toEqual([])
  })
})
