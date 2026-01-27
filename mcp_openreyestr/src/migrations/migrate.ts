import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runMigrations() {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435'),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'openreyestr',
  });

  try {
    console.log('Running migrations...');

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
    await pool.end();
  }
}

runMigrations().catch(console.error);
