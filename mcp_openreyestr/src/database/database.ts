import { Pool, PoolConfig, QueryResult, QueryResultRow } from 'pg';

export interface DatabaseConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  schema?: string;
}

export class Database {
  private pool: Pool;
  private schema?: string;

  constructor(config?: DatabaseConfig) {
    const dbConfig = config || {
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5435'),
      user: process.env.POSTGRES_USER || 'openreyestr',
      password: process.env.POSTGRES_PASSWORD || 'openreyestr_password',
      database: process.env.POSTGRES_DB || 'openreyestr',
    };

    this.schema = dbConfig.schema;

    const poolConfig: PoolConfig = {
      host: dbConfig.host,
      port: dbConfig.port,
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };

    this.pool = new Pool(poolConfig);

    this.pool.on('error', (err) => {
      console.error('Unexpected database error:', err);
    });
  }

  async connect(): Promise<void> {
    try {
      const client = await this.pool.connect();
      if (this.schema) {
        await client.query(`SET search_path TO ${this.schema}`);
      }
      client.release();
    } catch (error) {
      console.error('Database connection error:', error);
      throw error;
    }
  }

  async query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
    const client = await this.pool.connect();
    try {
      if (this.schema) {
        await client.query(`SET search_path TO ${this.schema}`);
      }
      return await client.query<T>(text, params);
    } finally {
      client.release();
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }

  getPool(): Pool {
    return this.pool;
  }
}
