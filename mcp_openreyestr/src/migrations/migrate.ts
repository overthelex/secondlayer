import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';
import { Database } from '../database/database';
import { logger } from '../utils/logger';
import { ensureBulkTablespace } from './ensure-bulk-tablespace';

dotenv.config();

async function runMigrations() {
  const db = new Database();

  try {
    await db.connect();
    logger.info('Connected to database, running migrations...');

    // Create migration tracking table if it doesn't exist
    await db.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Auto-discover all .sql files in the migrations directory, sorted alphabetically
    const migrationsDir = __dirname;
    const files = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    logger.info(`Found ${files.length} migration files`);

    for (const file of files) {
      // Check if migration was already applied
      const result = await db.query(
        'SELECT 1 FROM schema_migrations WHERE filename = $1',
        [file]
      );

      if (result.rows.length > 0) {
        logger.info(`Migration ${file} already applied, skipping...`);
        continue;
      }

      const migrationPath = join(migrationsDir, file);
      const sql = readFileSync(migrationPath, 'utf-8');

      try {
        await db.query(sql);
        await db.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [file]
        );
        logger.info(`Migration ${file} completed successfully`);
      } catch (error: any) {
        // Log but don't fail on "already exists" errors (safety net for pre-tracking migrations)
        if (
          error.message.includes('already exists') ||
          error.message.includes('duplicate') ||
          error.message.includes('is not unique')
        ) {
          await db.query(
            'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
            [file]
          );
          logger.info(`Migration ${file} already applied (skipped duplicate), marking as done`);
        } else {
          throw error;
        }
      }
    }

    // CREATE TABLESPACE cannot run in a transaction block, so not a .sql file (see the module)
    await ensureBulkTablespace(db, logger);

    logger.info('All migrations completed!');
    await db.close();
  } catch (error) {
    logger.error('Migration failed:', error);
    await db.close();
    process.exit(1);
  }
}

runMigrations();
