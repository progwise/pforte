export interface Config {
  port: number
  databaseUrl: string
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required')
  }
  return {
    port: Number(env.PORT ?? 3300),
    databaseUrl,
  }
}
