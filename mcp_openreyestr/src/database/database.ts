import { types as pgTypes } from 'pg';
import { BaseDatabase, DatabaseConfig, registerPgTypeParsers } from '@secondlayer/shared';

// DATE -> 'YYYY-MM-DD' for this service's own pg copy too (LEXAI-2105; see pg-type-parsers.ts).
registerPgTypeParsers(pgTypes);

export class Database extends BaseDatabase {
  constructor(config?: Partial<DatabaseConfig>) {
    const schema = (process.env.POSTGRES_SCHEMA || config?.schema || '').trim() || undefined;
    super({
      host: process.env.POSTGRES_HOST || config?.host || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || String(config?.port || 5435)),
      user: process.env.POSTGRES_USER || config?.user || 'openreyestr',
      password: process.env.POSTGRES_PASSWORD || config?.password || 'openreyestr_password',
      database: process.env.POSTGRES_DB || config?.database || 'openreyestr',
      schema,
    });
  }
}
