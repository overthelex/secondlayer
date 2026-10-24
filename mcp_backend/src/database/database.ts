import { types as pgTypes } from 'pg';
import { BaseDatabase, DatabaseConfig, registerPgTypeParsers } from '@secondlayer/shared';
import type { IDatabase } from '../domain/ports/index.js';

// DATE -> 'YYYY-MM-DD' for this service's own pg copy too (LEXAI-2105; see pg-type-parsers.ts).
registerPgTypeParsers(pgTypes);

export class Database extends BaseDatabase implements IDatabase {
  constructor() {
    const config: DatabaseConfig = {
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432'),
      user: process.env.POSTGRES_USER || 'secondlayer',
      password: process.env.POSTGRES_PASSWORD || 'secondlayer_password',
      database: process.env.POSTGRES_DB || 'secondlayer_db',
    };
    super(config);
  }
}
