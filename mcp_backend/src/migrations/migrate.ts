import { readFileSync } from 'fs';
import { join } from 'path';
import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';

async function runMigrations() {
  const db = new Database();
  
  try {
    await db.connect();
    logger.info('Connected to database, running migrations...');
    
    // Read migration file
    const schemaPath = join(process.cwd(), 'src/migrations/001_initial_schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    
    // Execute the entire schema (it uses IF NOT EXISTS, so safe to run multiple times)
    try {
      await db.query(schema);
      logger.info('✅ Initial schema migration completed successfully');
    } catch (error: any) {
      // Log but don't fail on "already exists" errors
      if (error.message.includes('already exists') || error.message.includes('duplicate')) {
        logger.info('Schema already exists, skipping...');
      } else {
        throw error;
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
