import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';

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

    // Get all migration files (*.sql) in sorted order
    const migrationsDir = join(process.cwd(), 'src/migrations');
    let files = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    // MIGRATION_SET narrows the history to one deployment's schema.
    //
    // The full history cannot build a database from zero: 126_spain_legal_data.sql
    // opens with "Tables already exist from prior schema" and then ALTERs tables
    // nothing ever created, so a run against an empty database stops there with
    // `relation "spain_eurlex_legislation" does not exist` (verified 2026-09-19).
    // Every deployment so far was therefore born from a dump of another box.
    //
    // Rather than back-fill twenty years of other jurisdictions' tables so that a
    // UK-only box can reach its own seven, a deployment names the set it needs.
    // lawrider.uk serves uk_* and nothing else; Spanish, Swiss, Polish and
    // Ukrainian schema is not absent by accident there, it is absent on purpose.
    //
    // Unlisted migrations are NOT recorded as applied. The set is a filter on what
    // runs, not a claim that the rest happened — so pointing a box at the full
    // history later still works, and schema_migrations keeps meaning what it says.
    const setName = (process.env.MIGRATION_SET || '').trim();
    if (setName) {
      const setPath = join(migrationsDir, 'sets', `${setName}.txt`);
      if (!existsSync(setPath)) {
        logger.error(`MIGRATION_SET=${setName} but ${setPath} does not exist`);
        process.exit(1);
      }
      const patterns = readFileSync(setPath, 'utf-8')
        .split('\n')
        .map(l => l.replace(/#.*$/, '').trim())
        .filter(Boolean);
      const matches = (f: string) => patterns.some(p =>
        p.includes('*')
          ? new RegExp('^' + p.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(f)
          : p === f);
      const before = files.length;
      files = files.filter(matches);
      logger.info(`MIGRATION_SET=${setName}: ${files.length} of ${before} migrations selected`);
      const unmatched = patterns.filter(p => !p.includes('*') && !files.includes(p));
      if (unmatched.length) {
        logger.error(`MIGRATION_SET=${setName} names migrations that do not exist: ${unmatched.join(', ')}`);
        process.exit(1);
      }
    }

    logger.info(`Found ${files.length} migration files`);

    // Execute each migration
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
      const migrationSql = readFileSync(migrationPath, 'utf-8');

      try {
        await db.query(migrationSql);
        await db.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [file]
        );
        logger.info(`✅ Migration ${file} completed successfully`);
      } catch (error: any) {
        // Log but don't fail on "already exists" errors (safety net for pre-tracking migrations)
        if (error.message.includes('already exists') || error.message.includes('duplicate') || error.message.includes('is not unique')) {
          // Record it as applied so it won't be retried
          await db.query(
            'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
            [file]
          );
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
