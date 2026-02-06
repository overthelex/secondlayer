/**
 * Direct SQL script to add credits to ChatGPT OAuth user
 * Standalone script that doesn't require TypeScript compilation
 */

import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '../.env') });
dotenv.config({ path: join(__dirname, '.env') });

const { Pool } = pg;

const CHATGPT_USER_ID = 'abfa4cd8-61de-4908-a778-4d23c1574f0a';
const CREDITS_TO_ADD = parseFloat(process.env.CREDITS || '100');

async function addCredits() {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    user: process.env.POSTGRES_USER || 'secondlayer',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'secondlayer_db',
  });

  try {
    console.log('💳 Adding credits to ChatGPT user...');
    console.log(`   User ID: ${CHATGPT_USER_ID}`);
    console.log(`   Credits: ${CREDITS_TO_ADD}`);

    // Check current balance
    const balanceBefore = await pool.query(
      'SELECT has_credits, current_balance, reason FROM check_user_balance($1, $2)',
      [CHATGPT_USER_ID, 0]
    );

    if (balanceBefore.rows.length > 0) {
      console.log(`   Current balance: ${balanceBefore.rows[0].current_balance}`);
    }

    // Add credits using PostgreSQL function
    const result = await pool.query(
      `SELECT success, new_balance, transaction_id
       FROM add_credits($1, $2, $3, $4, $5, $6, $7)`,
      [
        CHATGPT_USER_ID,
        CREDITS_TO_ADD,
        'bonus', // transaction_type
        'manual_grant', // source
        'chatgpt-integration-test', // source_id
        'Initial credits for ChatGPT MCP integration testing', // description
        null, // stripe_payment_intent_id
      ]
    );

    if (result.rows.length > 0 && result.rows[0].success) {
      console.log('✅ Credits added successfully!');
      console.log(`   New balance: ${result.rows[0].new_balance}`);
      console.log(`   Transaction ID: ${result.rows[0].transaction_id}`);

      // Verify final balance
      const balanceAfter = await pool.query(
        'SELECT has_credits, current_balance FROM check_user_balance($1, $2)',
        [CHATGPT_USER_ID, 1]
      );

      if (balanceAfter.rows.length > 0) {
        console.log(`   Has credits for tool call: ${balanceAfter.rows[0].has_credits}`);
      }

      // Get user info
      const userInfo = await pool.query(
        'SELECT email, name FROM users WHERE id = $1',
        [CHATGPT_USER_ID]
      );

      if (userInfo.rows.length > 0) {
        console.log(`   User: ${userInfo.rows[0].name || 'N/A'} (${userInfo.rows[0].email})`);
      }

      console.log('\n🎉 ChatGPT user is ready to use MCP tools!');
    } else {
      console.error('❌ Failed to add credits');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

// Run
addCredits()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
