import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

async function setupDatabase() {
  // Connect to PostgreSQL without specific database
  const adminPool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435'),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: 'postgres',
  });

  const dbName = process.env.POSTGRES_DB || 'openreyestr';

  try {
    console.log(`Creating database ${dbName}...`);

    // Check if database exists
    const result = await adminPool.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName]
    );

    if (result.rows.length === 0) {
      await adminPool.query(`CREATE DATABASE ${dbName}`);
      console.log(`Database ${dbName} created successfully`);
    } else {
      console.log(`Database ${dbName} already exists`);
    }
  } catch (error) {
    console.error('Database setup error:', error);
    throw error;
  } finally {
    await adminPool.end();
  }

  console.log('Running migrations...');
  // Import and run migrations
  await import('./migrate.js');
}

setupDatabase().catch(console.error);
