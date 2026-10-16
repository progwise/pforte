import Fastify from 'fastify'

export interface AppDependencies {
  /** Returns the current time as reported by the database. */
  getDatabaseTime: () => Promise<Date>
}

export const buildApp = ({ getDatabaseTime }: AppDependencies) => {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' })

  app.get('/health', async (_request, reply) => {
    try {
      const databaseTime = await getDatabaseTime()
      return { status: 'ok', databaseTime: databaseTime.toISOString() }
    } catch (error) {
      app.log.error(error, 'health check failed')
      return reply.code(503).send({ status: 'error' })
    }
  })

  return app
}
