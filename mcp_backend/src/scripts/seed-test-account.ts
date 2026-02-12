/**
 * Test Account Seed Script
 * Creates a test user with balance and transactions for development/demo
 *
 * Usage:
 *   npm run seed:test-account       # Create test data
 *   npm run seed:test-account:clean # Remove test data
 *
 * Or with ts-node:
 *   npx ts-node src/scripts/seed-test-account.ts
 *   npx ts-node src/scripts/seed-test-account.ts --cleanup
 */

import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';

const TEST_USER = {
  email: process.env.TEST_ACCOUNT_EMAIL || 'test@legal.org.ua',
  name: process.env.TEST_ACCOUNT_NAME || 'Test User',
  googleId: 'test-google-id-12345',
  picture: 'https://via.placeholder.com/150',
  balance: parseFloat(process.env.TEST_ACCOUNT_BALANCE || '100.00'),
};

async function cleanupTestAccount() {
  const db = new Database();

  try {
    await db.connect();
    logger.info('Cleaning up test account data...');

    const existingUser = await db.query(
      'SELECT id FROM users WHERE email = $1',
      [TEST_USER.email]
    );

    if (existingUser.rows.length === 0) {
      logger.info('No test user found, nothing to clean up');
      return;
    }

    const userId = existingUser.rows[0].id;
    logger.info(`Found test user: ${TEST_USER.email} (ID: ${userId})`);

    // Must drop immutability rules to allow FK cascade
    await db.query(`
      DROP RULE IF EXISTS no_delete_custody_chain ON document_custody_chain;
      DROP RULE IF EXISTS no_update_custody_chain ON document_custody_chain;
      DROP RULE IF EXISTS no_delete_audit_log ON audit_log;
      DROP RULE IF EXISTS no_update_audit_log ON audit_log;
    `);

    // Delete all data in FK-safe order
    await db.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM matter_invoices WHERE created_by = $1)', [userId]);
    await db.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM matter_invoices WHERE created_by = $1)', [userId]);
    await db.query('UPDATE time_entries SET invoice_id = NULL WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM matter_invoices WHERE created_by = $1', [userId]);
    await db.query('DELETE FROM active_timers WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM time_entries WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM user_billing_rates WHERE user_id = $1 OR created_by = $1', [userId]);
    await db.query('DELETE FROM billing_transactions WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM payment_intents WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM credit_transactions WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM audit_log WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM cost_tracking WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM conversations WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM documents WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM upload_sessions WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM user_request_preferences WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM user_sessions WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM eula_acceptances WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM matter_team WHERE user_id = $1 OR added_by = $1', [userId]);
    await db.query('DELETE FROM matters WHERE created_by = $1', [userId]);
    await db.query('DELETE FROM clients WHERE created_by = $1', [userId]);
    await db.query('DELETE FROM user_billing WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM user_credits WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM users WHERE id = $1', [userId]);

    // Restore immutability rules
    await db.query(`
      CREATE RULE no_update_custody_chain AS ON UPDATE TO document_custody_chain DO INSTEAD NOTHING;
      CREATE RULE no_delete_custody_chain AS ON DELETE TO document_custody_chain DO INSTEAD NOTHING;
      CREATE RULE no_update_audit_log AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
      CREATE RULE no_delete_audit_log AS ON DELETE TO audit_log DO INSTEAD NOTHING;
    `);

    logger.info('Test account and all related data deleted successfully');
  } catch (error: any) {
    logger.error('Error cleaning up test account:', error);
    // Try to restore rules even on error
    try {
      await db.query(`
        CREATE RULE IF NOT EXISTS no_update_custody_chain AS ON UPDATE TO document_custody_chain DO INSTEAD NOTHING;
        CREATE RULE IF NOT EXISTS no_delete_custody_chain AS ON DELETE TO document_custody_chain DO INSTEAD NOTHING;
        CREATE RULE IF NOT EXISTS no_update_audit_log AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
        CREATE RULE IF NOT EXISTS no_delete_audit_log AS ON DELETE TO audit_log DO INSTEAD NOTHING;
      `);
    } catch { /* ignore */ }
    throw error;
  } finally {
    await db.close();
  }
}

async function seedTestAccount() {
  const db = new Database();

  try {
    await db.connect();
    logger.info('Starting test account seed...');

    // 1. Check if test user already exists
    const existingUser = await db.query(
      'SELECT id FROM users WHERE email = $1',
      [TEST_USER.email]
    );

    let userId: string;

    if (existingUser.rows.length > 0) {
      userId = existingUser.rows[0].id;
      logger.info(`Test user already exists: ${TEST_USER.email} (ID: ${userId})`);
    } else {
      // Create test user
      const userResult = await db.query(
        `INSERT INTO users (email, name, google_id, picture, email_verified)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id`,
        [TEST_USER.email, TEST_USER.name, TEST_USER.googleId, TEST_USER.picture]
      );

      userId = userResult.rows[0].id;
      logger.info(`Created test user: ${TEST_USER.email} (ID: ${userId})`);
    }

    // 2. Check if billing record exists
    const existingBilling = await db.query(
      'SELECT id FROM user_billing WHERE user_id = $1',
      [userId]
    );

    if (existingBilling.rows.length > 0) {
      await db.query(
        `UPDATE user_billing
         SET balance_usd = $1,
             daily_limit_usd = 10.00,
             monthly_limit_usd = 100.00,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $2`,
        [TEST_USER.balance, userId]
      );
      logger.info(`Updated test user billing: $${TEST_USER.balance}`);
    } else {
      await db.query(
        `INSERT INTO user_billing (
          user_id, balance_usd, balance_uah,
          daily_limit_usd, monthly_limit_usd,
          total_spent_usd, total_requests, is_active, billing_enabled
        )
        VALUES ($1, $2, 0, 10.00, 100.00, 0, 0, true, true)`,
        [userId, TEST_USER.balance]
      );
      logger.info(`Created billing record: $${TEST_USER.balance}`);
    }

    // 3. Create mock transactions
    const transactions = [
      { type: 'topup', amount_usd: 20.00, provider: 'stripe', desc: 'Initial top-up via Stripe' },
      { type: 'topup', amount_usd: 25.00, provider: 'stripe', desc: 'Balance top-up via Stripe' },
      { type: 'topup', amount_usd: 15.00, provider: 'fondy', desc: 'Balance top-up via Fondy', amount_uah: 555.56 },
      { type: 'topup', amount_usd: 30.00, provider: 'manual', desc: 'Manual credit adjustment' },
      { type: 'topup', amount_usd: 10.00, provider: 'stripe', desc: 'Balance top-up via Stripe' },
      { type: 'charge', amount_usd: -2.50, provider: null, desc: 'Tool execution: search_court_cases' },
      { type: 'charge', amount_usd: -5.00, provider: null, desc: 'Tool execution: semantic_search' },
      { type: 'charge', amount_usd: -1.25, provider: null, desc: 'Tool execution: get_document_text' },
      { type: 'charge', amount_usd: -3.75, provider: null, desc: 'Tool execution: packaged_lawyer_answer' },
      { type: 'charge', amount_usd: -4.50, provider: null, desc: 'Tool execution: validate_citations' },
    ];

    let currentBalance = 0;

    for (const tx of transactions) {
      currentBalance += tx.amount_usd;

      await db.query(
        `INSERT INTO billing_transactions (
          user_id, type, amount_usd, amount_uah,
          balance_before_usd, balance_after_usd,
          payment_provider, description,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() - interval '${Math.random() * 30} days')`,
        [
          userId,
          tx.type,
          Math.abs(tx.amount_usd),
          tx.amount_uah || 0,
          currentBalance - tx.amount_usd,
          currentBalance,
          tx.provider,
          tx.desc,
        ]
      );
    }

    logger.info(`Created ${transactions.length} mock transactions`);

    // 4. Create mock payment intents
    const paymentIntents = [
      {
        provider: 'stripe',
        external_id: 'pi_test_succeeded_' + Date.now(),
        amount_usd: 25.00,
        status: 'succeeded',
      },
      {
        provider: 'stripe',
        external_id: 'pi_test_pending_' + Date.now(),
        amount_usd: 50.00,
        status: 'pending',
      },
      {
        provider: 'fondy',
        external_id: 'SL-' + userId.substring(0, 8) + '-' + Date.now(),
        amount_uah: 555.56,
        status: 'succeeded',
      },
    ];

    for (const intent of paymentIntents) {
      await db.query(
        `INSERT INTO payment_intents (
          user_id, provider, external_id,
          amount_usd, amount_uah, status, metadata,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() - interval '${Math.random() * 15} days')`,
        [
          userId,
          intent.provider,
          intent.external_id,
          intent.amount_usd || 0,
          intent.amount_uah || 0,
          intent.status,
          JSON.stringify({ test: true }),
        ]
      );
    }

    logger.info(`Created ${paymentIntents.length} mock payment intents`);

    // 5. Verify final state
    const finalBilling = await db.query(
      `SELECT balance_usd, balance_uah, total_requests, is_active
       FROM user_billing
       WHERE user_id = $1`,
      [userId]
    );

    const billing = finalBilling.rows[0];
    logger.info('\nTest Account Summary:');
    logger.info(`   Email: ${TEST_USER.email}`);
    logger.info(`   User ID: ${userId}`);
    logger.info(`   Balance: $${billing.balance_usd} USD`);
    logger.info(`   Transactions: ${transactions.length}`);
    logger.info(`   Payment Intents: ${paymentIntents.length}`);
    logger.info('\nTest account seed completed successfully!');
  } catch (error: any) {
    logger.error('Error seeding test account:', error);
    throw error;
  } finally {
    await db.close();
  }
}

// CLI: --cleanup flag triggers cleanup instead of seed
const isCleanup = process.argv.includes('--cleanup');

(isCleanup ? cleanupTestAccount() : seedTestAccount())
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });

export { seedTestAccount, cleanupTestAccount };
