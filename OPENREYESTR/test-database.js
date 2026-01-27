#!/usr/bin/env node
/**
 * Test database connection and display schema information
 */

const { Client } = require('pg');
require('dotenv').config();

async function testDatabase() {
  console.log('==========================================');
  console.log('Database Connection Test');
  console.log('==========================================\n');

  const {
    POSTGRES_ODATA_HOST = 'localhost',
    POSTGRES_ODATA_PORT = '5432',
    POSTGRES_ODATA_DB,
    POSTGRES_ODATA_USER,
    POSTGRES_ODATA_PASSWORD
  } = process.env;

  if (!POSTGRES_ODATA_DB || !POSTGRES_ODATA_USER || !POSTGRES_ODATA_PASSWORD) {
    console.error('❌ Error: Database credentials not configured in .env');
    process.exit(1);
  }

  const client = new Client({
    host: POSTGRES_ODATA_HOST,
    port: parseInt(POSTGRES_ODATA_PORT),
    user: POSTGRES_ODATA_USER,
    password: POSTGRES_ODATA_PASSWORD,
    database: POSTGRES_ODATA_DB
  });

  try {
    console.log('Connecting to database...');
    await client.connect();
    console.log('✓ Connected successfully\n');

    // Test 1: Get table count
    const tableResult = await client.query(`
      SELECT COUNT(*) as count
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    `);
    console.log(`Tables: ${tableResult.rows[0].count}`);

    // Test 2: List all tables with row counts
    console.log('\nTable Information:');
    console.log('─'.repeat(70));

    const tables = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    for (const table of tables.rows) {
      const countResult = await client.query(`SELECT COUNT(*) FROM ${table.table_name}`);
      const count = countResult.rows[0].count;
      console.log(`  ${table.table_name.padEnd(30)} ${count.toString().padStart(10)} rows`);
    }

    // Test 3: Check registry metadata
    console.log('\nRegistry Metadata:');
    console.log('─'.repeat(70));

    const registries = await client.query(`
      SELECT registry_id, registry_name, update_frequency
      FROM registry_metadata
      ORDER BY registry_id
    `);

    registries.rows.forEach(reg => {
      console.log(`  ${reg.registry_id.toString().padStart(2)}. ${reg.registry_name.padEnd(25)} (${reg.update_frequency})`);
    });

    // Test 4: Check indexes
    const indexResult = await client.query(`
      SELECT COUNT(*) as count
      FROM pg_indexes
      WHERE schemaname = 'public'
    `);
    console.log(`\nIndexes: ${indexResult.rows[0].count}`);

    // Test 5: Database size
    const sizeResult = await client.query(`
      SELECT pg_size_pretty(pg_database_size($1)) as size
    `, [POSTGRES_ODATA_DB]);
    console.log(`Database size: ${sizeResult.rows[0].size}`);

    console.log('\n==========================================');
    console.log('✅ All tests passed!');
    console.log('==========================================\n');

    console.log('Connection string:');
    console.log(`postgresql://${POSTGRES_ODATA_USER}:****@${POSTGRES_ODATA_HOST}:${POSTGRES_ODATA_PORT}/${POSTGRES_ODATA_DB}\n`);

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

testDatabase().catch(console.error);
