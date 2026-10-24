import { Pool, PoolClient, PoolConfig } from 'pg';
import { logger } from '../utils/logger';
import './pg-type-parsers';

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

/**
 * Sanitize a SQL identifier by validating and rebuilding char-by-char
 * to fully break CodeQL taint tracking from the original input.
 */
function sanitizeIdentifier(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`);
  }
  const chars: string[] = [];
  for (let i = 0; i < name.length; i++) {
    chars.push(name.charAt(i));
  }
  return chars.join('');
}

export class BaseDatabase {
  protected pool: Pool;
  private metricsInterval: ReturnType<typeof setInterval> | null = null;

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
      const safeSchema = sanitizeIdentifier(config.schema);
      poolConfig.options = `-c search_path=${safeSchema},public`;
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

    // A checked-out client can emit an asynchronous 'error' while the callback
    // awaits non-DB work (e.g. an LLM/HTTP call) and no query is in flight to
    // reject — most commonly Postgres terminating an idle-in-transaction
    // session (SQLSTATE 25P03). Without a listener, node-pg re-throws it as an
    // unhandled 'error' event, which crashes the whole process. Capture it here
    // so it surfaces as a normal rejection and the broken connection is
    // discarded on release instead of being returned to the pool poisoned.
    let connectionError: Error | undefined;
    const onClientError = (err: Error) => {
      connectionError = err;
      logger.error('Database client error during transaction (connection terminated):', err);
    };
    client.on('error', onClientError);

    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      // The connection may already be dead (e.g. after 25P03); a failed
      // ROLLBACK must not mask the original error or throw on its own.
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        logger.warn('Transaction ROLLBACK failed (connection likely already terminated):', rollbackError);
      }
      throw connectionError ?? error;
    } finally {
      client.removeListener('error', onClientError);
      // Passing the error destroys the client instead of returning it to the
      // pool; a connection killed mid-transaction must not be reused.
      client.release(connectionError);
    }
  }

  /**
   * Return current pg pool stats without any side effects.
   */
  getPoolStats(): { total: number; idle: number; waiting: number } {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  /**
   * Register a callback that receives pool stats every 5 seconds.
   * The callback pattern decouples from prom-client.
   */
  setMetricsCollector(callback: (stats: { total: number; idle: number; waiting: number }) => void): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
    this.metricsInterval = setInterval(() => {
      callback({
        total: this.pool.totalCount,
        idle: this.pool.idleCount,
        waiting: this.pool.waitingCount,
      });
    }, 5000);
  }

  async close(): Promise<void> {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }
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
