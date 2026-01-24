import { BaseDatabase, DatabaseConfig } from '@secondlayer/shared';

export class Database extends BaseDatabase {
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
