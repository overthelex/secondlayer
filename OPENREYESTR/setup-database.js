#!/usr/bin/env node
/**
 * Database Setup Script for NAIS Open Data
 * Creates database, user, and schema for all 11 registries
 */

const { Client } = require('pg');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const readline = require('readline');

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function setupDatabase() {
  console.log('==========================================');
  console.log('NAIS Open Data Database Setup');
  console.log('==========================================\n');

  // Load environment variables
  const {
    POSTGRES_ODATA_HOST = 'localhost',
    POSTGRES_ODATA_PORT = '5432',
    POSTGRES_ODATA_DB,
    POSTGRES_ODATA_USER,
    POSTGRES_ODATA_PASSWORD
  } = process.env;

  if (!POSTGRES_ODATA_DB || !POSTGRES_ODATA_USER || !POSTGRES_ODATA_PASSWORD) {
    console.error('❌ Error: Required environment variables not set');
    console.error('   Please ensure POSTGRES_ODATA_DB, POSTGRES_ODATA_USER, and POSTGRES_ODATA_PASSWORD are defined in .env');
    process.exit(1);
  }

  console.log(`Database: ${POSTGRES_ODATA_DB}`);
  console.log(`User: ${POSTGRES_ODATA_USER}`);
  console.log(`Host: ${POSTGRES_ODATA_HOST}`);
  console.log(`Port: ${POSTGRES_ODATA_PORT}\n`);

  // Prompt for admin password
  console.log('Creating database and user requires PostgreSQL admin access');
  const adminPassword = await prompt('Enter PostgreSQL admin (postgres) password: ');
  console.log('');

  // Connect as admin
  const adminClient = new Client({
    host: POSTGRES_ODATA_HOST,
    port: parseInt(POSTGRES_ODATA_PORT),
    user: 'postgres',
    password: adminPassword,
    database: 'postgres'
  });

  try {
    console.log('Connecting to PostgreSQL...');
    await adminClient.connect();
    console.log('✓ Connected to PostgreSQL\n');

    // Create user if not exists
    console.log('Creating database user...');
    try {
      await adminClient.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_user WHERE usename = '${POSTGRES_ODATA_USER}') THEN
            CREATE USER ${POSTGRES_ODATA_USER} WITH PASSWORD '${POSTGRES_ODATA_PASSWORD}';
          END IF;
        END
        $$;
      `);
      console.log(`✓ User '${POSTGRES_ODATA_USER}' created or already exists`);
    } catch (error) {
      console.error('❌ Error creating user:', error.message);
      process.exit(1);
    }

    // Create database if not exists
    console.log('Creating database...');
    try {
      const dbCheck = await adminClient.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [POSTGRES_ODATA_DB]
      );

      if (dbCheck.rows.length === 0) {
        await adminClient.query(`CREATE DATABASE ${POSTGRES_ODATA_DB} OWNER ${POSTGRES_ODATA_USER}`);
        console.log(`✓ Database '${POSTGRES_ODATA_DB}' created`);
      } else {
        console.log(`✓ Database '${POSTGRES_ODATA_DB}' already exists`);
      }
    } catch (error) {
      console.error('❌ Error creating database:', error.message);
      process.exit(1);
    }

    // Grant privileges
    console.log('Granting privileges...');
    try {
      await adminClient.query(`GRANT ALL PRIVILEGES ON DATABASE ${POSTGRES_ODATA_DB} TO ${POSTGRES_ODATA_USER}`);
      await adminClient.query(`ALTER DATABASE ${POSTGRES_ODATA_DB} OWNER TO ${POSTGRES_ODATA_USER}`);
      console.log('✓ Privileges granted');
    } catch (error) {
      console.error('❌ Error granting privileges:', error.message);
      process.exit(1);
    }

    await adminClient.end();

    // Connect to new database as the new user
    console.log('\nRunning database schema...');
    const userClient = new Client({
      host: POSTGRES_ODATA_HOST,
      port: parseInt(POSTGRES_ODATA_PORT),
      user: POSTGRES_ODATA_USER,
      password: POSTGRES_ODATA_PASSWORD,
      database: POSTGRES_ODATA_DB
    });

    await userClient.connect();

    // Read and execute schema
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = await fs.readFile(schemaPath, 'utf-8');

    await userClient.query(schemaSql);
    console.log('✓ Schema created successfully');

    // Get table count
    const tableCount = await userClient.query(`
      SELECT COUNT(*)
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    `);

    await userClient.end();

    console.log('\n==========================================');
    console.log('✅ Database Setup Complete!');
    console.log('==========================================\n');
    console.log(`Database: ${POSTGRES_ODATA_DB}`);
    console.log(`User: ${POSTGRES_ODATA_USER}`);
    console.log(`Tables created: ${tableCount.rows[0].count}`);
    console.log('\nConnection URL:');
    console.log(`postgresql://${POSTGRES_ODATA_USER}:****@${POSTGRES_ODATA_HOST}:${POSTGRES_ODATA_PORT}/${POSTGRES_ODATA_DB}`);
    console.log('\nYou can now connect to the database using:');
    console.log(`psql -h ${POSTGRES_ODATA_HOST} -p ${POSTGRES_ODATA_PORT} -U ${POSTGRES_ODATA_USER} -d ${POSTGRES_ODATA_DB}`);
    console.log('');

  } catch (error) {
    console.error('\n❌ Setup failed:', error.message);
    process.exit(1);
  }
}

// Run setup
setupDatabase().catch(console.error);
