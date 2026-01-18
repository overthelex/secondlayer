import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';

async function runMigrations() {
  const db = new Database();

  try {
    await db.connect();
    logger.info('Connected to database, running migrations...');

    // Get all migration files (*.sql) in sorted order
    const migrationsDir = join(process.cwd(), 'src/migrations');
    const files = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    logger.info(`Found ${files.length} migration files`);

    // Execute each migration
    for (const file of files) {
      const migrationPath = join(migrationsDir, file);
      const migrationSql = readFileSync(migrationPath, 'utf-8');

      try {
        await db.query(migrationSql);
        logger.info(`✅ Migration ${file} completed successfully`);
      } catch (error: any) {
        // Log but don't fail on "already exists" errors
        if (error.message.includes('already exists') || error.message.includes('duplicate')) {
          logger.info(`Migration ${file} already applied, skipping...`);
        } else {
          throw error;
        }
      }
    }

    logger.info('✅ All migrations completed successfully');
    await db.close();
  } catch (error) {
    logger.error('❌ Migration failed:', error);
    await db.close();
    process.exit(1);
  }
}

runMigrations();
