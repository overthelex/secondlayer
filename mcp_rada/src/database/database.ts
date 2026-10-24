import { types as pgTypes } from 'pg';
import { BaseDatabase, DatabaseConfig, registerPgTypeParsers } from '@secondlayer/shared';

// DATE -> 'YYYY-MM-DD' for this service's own pg copy too (LEXAI-2105; see pg-type-parsers.ts).
registerPgTypeParsers(pgTypes);

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
