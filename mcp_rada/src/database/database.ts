import { BaseDatabase, DatabaseConfig } from '@secondlayer/shared';

export class Database extends BaseDatabase {
  constructor() {
    const schema = (process.env.POSTGRES_SCHEMA || '').trim() || undefined;
    const config: DatabaseConfig = {
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5433'),
      user: process.env.POSTGRES_USER || 'rada_mcp',
      password: process.env.POSTGRES_PASSWORD || 'rada_password',
      database: process.env.POSTGRES_DB || 'rada_db',
      schema,
    };
    super(config);
  }
}
