#!/usr/bin/env ts-node
/**
 * CLI Tool: Bulk API Key Generator
 * Creates API keys for multiple users
 *
 * Usage:
 *   npm run create-api-keys -- --email user@example.com --name "My API Key"
 *   npm run create-api-keys -- --batch users.csv
 *   npm run create-api-keys -- --user-id <uuid> --count 5
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

// Database connection
const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB || 'secondlayer',
  user: process.env.POSTGRES_USER || 'secondlayer',
  password: process.env.POSTGRES_PASSWORD,
});

interface ApiKey {
  id: string;
  userId: string;
  key: string;
  name: string;
  userEmail: string;
  createdAt: Date;
}

/**
 * Create API key for user by email
 */
async function createApiKeyByEmail(
  email: string,
  keyName: string,
  description?: string,
  expiresAt?: Date
): Promise<ApiKey | null> {
  const client = await pool.connect();
  try {
    // Find user by email
    const userResult = await client.query(
      'SELECT id, email FROM users WHERE email = $1',
      [email]
    );

    if (userResult.rows.length === 0) {
      console.error(`❌ User not found: ${email}`);
      return null;
    }

    const user = userResult.rows[0];

    // Create API key
    const keyResult = await client.query<ApiKey>(
      `INSERT INTO api_keys (user_id, key, name, description, expires_at)
       VALUES ($1, generate_api_key(), $2, $3, $4)
       RETURNING id, user_id as "userId", key, name, created_at as "createdAt"`,
      [user.id, keyName, description || null, expiresAt || null]
    );

    const apiKey = keyResult.rows[0];

    return {
      ...apiKey,
      userEmail: user.email,
    };
  } finally {
    client.release();
  }
}

/**
 * Create API key for user by ID
 */
async function createApiKeyByUserId(
  userId: string,
  keyName: string,
  description?: string,
  expiresAt?: Date
): Promise<ApiKey | null> {
  const client = await pool.connect();
  try {
    // Verify user exists
    const userResult = await client.query(
      'SELECT id, email FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      console.error(`❌ User not found: ${userId}`);
      return null;
    }

    const user = userResult.rows[0];

    // Create API key
    const keyResult = await client.query<ApiKey>(
      `INSERT INTO api_keys (user_id, key, name, description, expires_at)
       VALUES ($1, generate_api_key(), $2, $3, $4)
       RETURNING id, user_id as "userId", key, name, created_at as "createdAt"`,
      [userId, keyName, description || null, expiresAt || null]
    );

    const apiKey = keyResult.rows[0];

    return {
      ...apiKey,
      userEmail: user.email,
    };
  } finally {
    client.release();
  }
}

/**
 * Bulk create API keys from CSV
 * CSV format: email,name,description,expires_at
 */
async function bulkCreateFromCSV(csvPath: string): Promise<void> {
  const csvContent = fs.readFileSync(csvPath, 'utf-8');
  const lines = csvContent.split('\n').filter(line => line.trim());

  // Skip header
  const dataLines = lines.slice(1);

  console.log(`📋 Processing ${dataLines.length} entries from CSV...`);

  const results: { success: ApiKey[]; failed: string[] } = {
    success: [],
    failed: [],
  };

  for (const line of dataLines) {
    const [email, name, description, expiresAt] = line.split(',').map(s => s.trim());

    if (!email || !name) {
      console.warn(`⚠️  Skipping invalid line: ${line}`);
      results.failed.push(line);
      continue;
    }

    const expiresDate = expiresAt ? new Date(expiresAt) : undefined;
    const apiKey = await createApiKeyByEmail(email, name, description, expiresDate);

    if (apiKey) {
      results.success.push(apiKey);
      console.log(`✅ Created key for ${email}: ${apiKey.key}`);
    } else {
      results.failed.push(line);
    }
  }

  console.log('\n📊 Summary:');
  console.log(`  ✅ Created: ${results.success.length}`);
  console.log(`  ❌ Failed: ${results.failed.length}`);

  // Save results to file
  const outputPath = path.join(
    path.dirname(csvPath),
    `api-keys-${Date.now()}.json`
  );

  fs.writeFileSync(
    outputPath,
    JSON.stringify(results, null, 2)
  );

  console.log(`\n💾 Results saved to: ${outputPath}`);
  console.log('\n⚠️  IMPORTANT: Save these API keys securely! They will not be shown again.');
}

/**
 * Create multiple keys for single user
 */
async function createMultipleKeys(
  email: string,
  count: number,
  namePrefix: string = 'API Key'
): Promise<void> {
  console.log(`🔑 Creating ${count} API keys for ${email}...`);

  const results: ApiKey[] = [];

  for (let i = 1; i <= count; i++) {
    const keyName = `${namePrefix} #${i}`;
    const apiKey = await createApiKeyByEmail(email, keyName);

    if (apiKey) {
      results.push(apiKey);
      console.log(`✅ ${i}/${count}: ${apiKey.key}`);
    }
  }

  console.log(`\n✅ Created ${results.length}/${count} API keys`);

  // Save to file
  const outputPath = `./api-keys-${email.replace('@', '-')}-${Date.now()}.json`;
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));

  console.log(`💾 Saved to: ${outputPath}`);
  console.log('\n⚠️  IMPORTANT: Save these API keys securely! They will not be shown again.');
}

/**
 * List all API keys (masked)
 */
async function listAllApiKeys(): Promise<void> {
  const result = await pool.query(`
    SELECT
      ak.id,
      u.email,
      ak.name,
      ak.is_active as "isActive",
      ak.usage_count as "usageCount",
      ak.last_used_at as "lastUsedAt",
      ak.created_at as "createdAt",
      substring(ak.key, 1, 12) || '...' || substring(ak.key, length(ak.key)-3, 4) as "maskedKey"
    FROM api_keys ak
    JOIN users u ON u.id = ak.user_id
    ORDER BY ak.created_at DESC
    LIMIT 100
  `);

  console.table(result.rows);
  console.log(`\nTotal: ${result.rows.length} API keys`);
}

/**
 * Main CLI
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
🔑 SecondLayer API Key Generator

Usage:
  # Create single API key by email
  npm run create-api-keys -- --email user@example.com --name "My API Key" [--description "Description"] [--expires "2025-12-31"]

  # Create single API key by user ID
  npm run create-api-keys -- --user-id <uuid> --name "My API Key"

  # Create multiple keys for one user
  npm run create-api-keys -- --email user@example.com --count 5 [--name-prefix "API Key"]

  # Bulk create from CSV file
  npm run create-api-keys -- --batch users.csv

  # List all API keys
  npm run create-api-keys -- --list

CSV Format:
  email,name,description,expires_at
  user@example.com,Production Key,Main API key,2025-12-31
  test@example.com,Test Key,Testing purposes,

Examples:
  npm run create-api-keys -- --email john@company.com --name "Production API Key"
  npm run create-api-keys -- --email john@company.com --count 3 --name-prefix "Service"
  npm run create-api-keys -- --batch ./users.csv
  npm run create-api-keys -- --list
`);
    process.exit(0);
  }

  try {
    if (args.includes('--list')) {
      await listAllApiKeys();
    } else if (args.includes('--batch')) {
      const csvPath = args[args.indexOf('--batch') + 1];
      if (!csvPath) {
        console.error('❌ Missing CSV file path');
        process.exit(1);
      }
      await bulkCreateFromCSV(csvPath);
    } else if (args.includes('--count')) {
      const email = args[args.indexOf('--email') + 1];
      const count = parseInt(args[args.indexOf('--count') + 1]);
      const namePrefix = args.includes('--name-prefix')
        ? args[args.indexOf('--name-prefix') + 1]
        : 'API Key';

      if (!email || !count) {
        console.error('❌ Missing --email or --count');
        process.exit(1);
      }

      await createMultipleKeys(email, count, namePrefix);
    } else if (args.includes('--email')) {
      const email = args[args.indexOf('--email') + 1];
      const name = args[args.indexOf('--name') + 1];
      const description = args.includes('--description')
        ? args[args.indexOf('--description') + 1]
        : undefined;
      const expires = args.includes('--expires')
        ? new Date(args[args.indexOf('--expires') + 1])
        : undefined;

      if (!email || !name) {
        console.error('❌ Missing --email or --name');
        process.exit(1);
      }

      const apiKey = await createApiKeyByEmail(email, name, description, expires);

      if (apiKey) {
        console.log('\n✅ API Key created successfully!');
        console.log('\n📋 Details:');
        console.log(`  ID: ${apiKey.id}`);
        console.log(`  User: ${apiKey.userEmail}`);
        console.log(`  Name: ${apiKey.name}`);
        console.log(`  Key: ${apiKey.key}`);
        console.log(`  Created: ${apiKey.createdAt}`);
        console.log('\n⚠️  IMPORTANT: Save this key securely! It will not be shown again.');
      } else {
        process.exit(1);
      }
    } else if (args.includes('--user-id')) {
      const userId = args[args.indexOf('--user-id') + 1];
      const name = args[args.indexOf('--name') + 1];
      const description = args.includes('--description')
        ? args[args.indexOf('--description') + 1]
        : undefined;

      if (!userId || !name) {
        console.error('❌ Missing --user-id or --name');
        process.exit(1);
      }

      const apiKey = await createApiKeyByUserId(userId, name, description);

      if (apiKey) {
        console.log('\n✅ API Key created successfully!');
        console.log(`\n  Key: ${apiKey.key}`);
        console.log('\n⚠️  Save this key securely!');
      } else {
        process.exit(1);
      }
    } else {
      console.error('❌ Invalid arguments. Use --help for usage information.');
      process.exit(1);
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
