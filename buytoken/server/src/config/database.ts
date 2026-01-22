/**
 * Database Configuration
 * Manages PostgreSQL connection pool
 */

import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

// Create connection pool
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://secondlayer:secondlayer_password@localhost:5432/secondlayer_db',
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test database connection
pool.on('connect', () => {
  console.log('✓ Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('❌ Unexpected database error:', err);
  process.exit(-1);
});

// Helper function to test connection
export async function testConnection(): Promise<boolean> {
  try {
    const result = await pool.query('SELECT NOW()');
    console.log('✓ Database connection test successful:', result.rows[0].now);
    return true;
  } catch (error) {
    console.error('❌ Database connection test failed:', error);
    return false;
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  await pool.end();
  console.log('✓ Database pool closed');
  process.exit(0);
});

export default pool;
