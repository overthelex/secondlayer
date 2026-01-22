/**
 * Database Migration Runner
 * Runs SQL migration files in order
 */

import { pool } from '../config/database.js';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create migrations tracking table
async function createMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      executed_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
}

// Get list of executed migrations
async function getExecutedMigrations(): Promise<string[]> {
  const result = await pool.query('SELECT filename FROM migrations ORDER BY id');
  return result.rows.map(row => row.filename);
}

// Mark migration as executed
async function markMigrationExecuted(filename: string) {
  await pool.query('INSERT INTO migrations (filename) VALUES ($1)', [filename]);
}

// Run migrations
export async function runMigrations() {
  try {
    console.log('🔄 Starting database migrations...\n');

    await createMigrationsTable();
    const executedMigrations = await getExecutedMigrations();

    // Get migration files
    const migrationsDir = join(__dirname, '../../src/migrations');
    const migrationFiles = readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort(); // Sort to ensure order

    let appliedCount = 0;

    for (const file of migrationFiles) {
      if (executedMigrations.includes(file)) {
        console.log(`⏭️  Skipping (already applied): ${file}`);
        continue;
      }

      console.log(`📝 Running migration: ${file}`);

      const sql = readFileSync(join(migrationsDir, file), 'utf-8');

      try {
        await pool.query(sql);
        await markMigrationExecuted(file);
        console.log(`✅ Applied: ${file}\n`);
        appliedCount++;
      } catch (error) {
        console.error(`❌ Failed to apply migration ${file}:`, error);
        throw error;
      }
    }

    console.log(`\n✓ Migration complete: ${appliedCount} new migration(s) applied`);
    console.log(`✓ Total migrations: ${executedMigrations.length + appliedCount}`);

  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().catch(console.error);
}
