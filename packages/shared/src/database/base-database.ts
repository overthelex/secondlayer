import { Pool, PoolClient, PoolConfig } from 'pg';
import { logger } from '../utils/logger';

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  schema?: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

export class BaseDatabase {
  protected pool: Pool;

  constructor(config: DatabaseConfig) {
    const poolConfig: PoolConfig = {
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      max: config.max ?? 100,
      idleTimeoutMillis: config.idleTimeoutMillis ?? 30000,
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? 2000,
    };

    if (config.schema) {
      poolConfig.options = `-c search_path=${config.schema},public`;
    }

    this.pool = new Pool(poolConfig);

    this.pool.on('error', (err) => {
      logger.error('Unexpected database error:', err);
    });
  }

  getPool(): Pool {
    return this.pool;
  }

  async connect(): Promise<void> {
    try {
      const client = await this.pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      logger.info('Database connected');
    } catch (error) {
      logger.error('Database connection failed:', error);
      throw error;
    }
  }

  async query(text: string, params?: any[]) {
    const start = Date.now();
    try {
      const result = await this.pool.query(text, params);
      const duration = Date.now() - start;
      logger.debug('Query executed', { text, duration, rows: result.rowCount });
      return result;
    } catch (error) {
      logger.error('Query error:', { text, error });
      throw error;
    }
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createDatabaseFromEnv(defaults: {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  schema?: string;
}): BaseDatabase {
  const config: DatabaseConfig = {
    host: process.env.POSTGRES_HOST || defaults.host || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || String(defaults.port || 5432)),
    user: process.env.POSTGRES_USER || defaults.user || 'postgres',
    password: process.env.POSTGRES_PASSWORD || defaults.password || 'password',
    database: process.env.POSTGRES_DB || defaults.database || 'postgres',
    schema: (process.env.POSTGRES_SCHEMA || defaults.schema || '').trim() || undefined,
    max: process.env.POSTGRES_POOL_MAX ? parseInt(process.env.POSTGRES_POOL_MAX) : undefined,
  };

  return new BaseDatabase(config);
}
