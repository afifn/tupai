import type { DbEngine } from '@shared/types'
import type { AdapterFactory } from './types'

type AdapterLoader = () => Promise<AdapterFactory>

const loaders: Record<DbEngine, AdapterLoader> = {
  mysql: async () => (await import('./mysql')).createMysqlAdapter,
  mariadb: async () => (await import('./mysql')).createMysqlAdapter,
  postgres: async () => (await import('./postgres')).createPostgresAdapter,
  oracle: async () => (await import('./oracle')).createOracleAdapter,
  sqlite: async () => (await import('./sqlite')).createSqliteAdapter,
  mongodb: async () => (await import('./mongodb')).createMongoAdapter
}

const cache = new Map<DbEngine, AdapterFactory>()

export async function getAdapterFactory(engine: DbEngine): Promise<AdapterFactory> {
  const cached = cache.get(engine)
  if (cached) return cached
  const factory = await loaders[engine]()
  cache.set(engine, factory)
  return factory
}
