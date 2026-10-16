import { describe, expect, it } from 'vitest'
import { buildApp } from './app.js'

describe('GET /health', () => {
  it('reports the database time', async () => {
    const app = buildApp({
      getDatabaseTime: async () => new Date('2026-01-01T12:00:00.000Z'),
    })

    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      status: 'ok',
      databaseTime: '2026-01-01T12:00:00.000Z',
    })
  })

  it('returns 503 when the database is unreachable', async () => {
    const app = buildApp({
      getDatabaseTime: async () => {
        throw new Error('connection refused')
      },
    })

    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ status: 'error' })
  })
})
