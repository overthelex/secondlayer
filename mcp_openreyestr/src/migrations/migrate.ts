import { readFileSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';
import { Database } from '../database/database';

dotenv.config();

async function runMigrations() {
  const db = new Database();

  try {
    console.log('Running migrations...');

    const pool = db.getPool();

    // Create migrations tracking table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Read migration files
    const migrations = [
      '001_initial_schema.sql',
      '002_add_cost_tracking.sql',
    ];

    for (const migrationFile of migrations) {
      // Check if migration was already executed
      const result = await pool.query(
        'SELECT * FROM migrations WHERE name = $1',
        [migrationFile]
      );

      if (result.rows.length > 0) {
        console.log(`Migration ${migrationFile} already executed, skipping...`);
        continue;
      }

      console.log(`Executing migration: ${migrationFile}`);
      const sql = readFileSync(join(__dirname, migrationFile), 'utf-8');

      await pool.query(sql);
      await pool.query(
        'INSERT INTO migrations (name) VALUES ($1)',
        [migrationFile]
      );

      console.log(`Migration ${migrationFile} completed successfully`);
    }

    console.log('All migrations completed!');
  } catch (error) {
    console.error('Migration error:', error);
    throw error;
  } finally {
    await db.close();
  }
}

runMigrations().catch(console.error);
