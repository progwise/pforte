import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schema } from './index.js'
import { createTestDatabase, hasDatabase, rejection } from './test/test-database.js'

describe.skipIf(!hasDatabase)('data model', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>

  beforeAll(async () => {
    database = await createTestDatabase()
  })

  afterAll(async () => {
    await database?.drop()
  })

  const insertUser = (email: string) =>
    database.pool.query(
      `insert into users (email, first_name, last_name) values ($1, 'Test', 'User') returning id`,
      [email],
    )

  it('rejects an e-mail that is not lowercase', async () => {
    const error = await rejection(insertUser('Mixed@Example.com'))
    expect(error.constraint).toBe('users_email_lowercase')
  })

  it('rejects a duplicate e-mail', async () => {
    await insertUser('dupe@example.com')
    const error = await rejection(insertUser('dupe@example.com'))
    expect(error.constraint).toBe('users_email_unique')
  })

  it('rejects the same claim value twice for one user', async () => {
    await database.pool.query(`insert into claim_types (key) values ('partner_no')`)
    const { rows } = await insertUser('claims@example.com')
    const addClaim = () =>
      database.pool.query(
        `insert into user_claims (user_id, claim_type_key, value) values ($1, 'partner_no', '00892')`,
        [rows[0].id],
      )
    await addClaim()
    const error = await rejection(addClaim())
    expect(error.constraint).toBe('user_claims_user_type_value')
  })

  it('rejects a claim for an unknown claim type', async () => {
    const { rows } = await insertUser('unknown-claim@example.com')
    const error = await rejection(
      database.pool.query(
        `insert into user_claims (user_id, claim_type_key, value) values ($1, 'nope', 'x')`,
        [rows[0].id],
      ),
    )
    expect(error.code).toBe('23503')
  })

  it('rejects a confidential client without a secret', async () => {
    const error = await rejection(
      database.pool.query(
        `insert into clients (client_id, name, type) values ('no-secret', 'No secret', 'confidential')`,
      ),
    )
    expect(error.constraint).toBe('clients_confidential_has_secret')
  })

  it('generates time-ordered UUID version 7 ids', async () => {
    const { rows } = await insertUser('uuid@example.com')
    expect(rows[0].id[14]).toBe('7')
  })

  it('updates updated_at when a row is changed through Drizzle', async () => {
    const [created] = await database.db
      .insert(schema.users)
      .values({ email: 'touch@example.com', firstName: 'Touch', lastName: 'Test' })
      .returning()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const [updated] = await database.db
      .update(schema.users)
      .set({ firstName: 'Changed' })
      .where(eq(schema.users.id, created!.id))
      .returning()
    expect(updated!.updatedAt.getTime()).toBeGreaterThan(created!.updatedAt.getTime())
  })

  it('keeps audit events after the target user is deleted', async () => {
    const { rows } = await insertUser('deleted@example.com')
    await database.pool.query(
      `insert into audit_events (actor_type, action, target_type, target_id, details)
       values ('system', 'user.delete', 'user', $1, '{"email":"deleted@example.com"}')`,
      [rows[0].id],
    )
    await database.pool.query(`delete from users where id = $1`, [rows[0].id])
    const events = await database.pool.query(`select 1 from audit_events where target_id = $1`, [rows[0].id])
    expect(events.rowCount).toBe(1)
  })

  it('has created_at and updated_at on every table except audit_events', async () => {
    const { rows } = await database.pool.query<{ table_name: string; columns: string[] }>(`
      select table_name, array_agg(column_name::text) as columns
      from information_schema.columns
      where table_schema = 'public' and table_name <> '__drizzle_migrations'
      group by table_name
    `)
    const tables = Object.fromEntries(rows.map((row) => [row.table_name, row.columns]))
    for (const [table, columns] of Object.entries(tables)) {
      expect(columns, table).toContain('created_at')
      if (table === 'audit_events') {
        expect(columns, table).not.toContain('updated_at')
      } else {
        expect(columns, table).toContain('updated_at')
      }
    }
  })
})
