/**
 * Test Account Seed Script
 * Creates a test user with balance and transactions for development/demo
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

async function seedTestAccount() {
  const db = new Database();

  try {
    await db.connect();
    logger.info('🌱 Starting test account seed...');

    // 1. Check if test user already exists
    const existingUser = await db.query(
      'SELECT id FROM users WHERE email = $1',
      [TEST_USER.email]
    );

    let userId: string;

    if (existingUser.rows.length > 0) {
      userId = existingUser.rows[0].id;
      logger.info(`✓ Test user already exists: ${TEST_USER.email} (ID: ${userId})`);
    } else {
      // Create test user
      const userResult = await db.query(
        `INSERT INTO users (email, name, google_id, picture, email_verified)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id`,
        [TEST_USER.email, TEST_USER.name, TEST_USER.googleId, TEST_USER.picture]
      );

      userId = userResult.rows[0].id;
      logger.info(`✓ Created test user: ${TEST_USER.email} (ID: ${userId})`);
    }

    // 2. Check if billing record exists
    const existingBilling = await db.query(
      'SELECT id FROM user_billing WHERE user_id = $1',
      [userId]
    );

    if (existingBilling.rows.length > 0) {
      // Update existing billing
      await db.query(
        `UPDATE user_billing
         SET balance_usd = $1,
             daily_limit_usd = 10.00,
             monthly_limit_usd = 100.00,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $2`,
        [TEST_USER.balance, userId]
      );
      logger.info(`✓ Updated test user billing: $${TEST_USER.balance}`);
    } else {
      // Create billing record
      await db.query(
        `INSERT INTO user_billing (
          user_id, balance_usd, balance_uah,
          daily_limit_usd, monthly_limit_usd,
          total_spent_usd, total_requests, is_active, billing_enabled
        )
        VALUES ($1, $2, 0, 10.00, 100.00, 0, 0, true, true)`,
        [userId, TEST_USER.balance]
      );
      logger.info(`✓ Created billing record: $${TEST_USER.balance}`);
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

    logger.info(`✓ Created ${transactions.length} mock transactions`);

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

    logger.info(`✓ Created ${paymentIntents.length} mock payment intents`);

    // 5. Verify final state
    const finalBilling = await db.query(
      `SELECT balance_usd, balance_uah, total_requests, is_active
       FROM user_billing
       WHERE user_id = $1`,
      [userId]
    );

    const billing = finalBilling.rows[0];
    logger.info('\n📊 Test Account Summary:');
    logger.info(`   Email: ${TEST_USER.email}`);
    logger.info(`   User ID: ${userId}`);
    logger.info(`   Balance: $${billing.balance_usd} USD, ₴${billing.balance_uah} UAH`);
    logger.info(`   Total Requests: ${billing.total_requests}`);
    logger.info(`   Active: ${billing.is_active}`);
    logger.info(`   Transactions: ${transactions.length}`);
    logger.info(`   Payment Intents: ${paymentIntents.length}`);
    logger.info('\n✅ Test account seed completed successfully!');
    logger.info('\n🔑 Login credentials:');
    logger.info(`   Email: ${TEST_USER.email}`);
    logger.info(`   Google OAuth: Use Google Sign-In with this email`);
    logger.info(`   Note: This is a test account for development purposes only\n`);
  } catch (error: any) {
    logger.error('❌ Error seeding test account:', error);
    throw error;
  } finally {
    await db.close();
  }
}

// Run if executed directly (when using ts-node or node directly)
// Note: This check is disabled for TypeScript compilation
// Use npm run seed:test-account:dev to run with ts-node
seedTestAccount()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });

export { seedTestAccount };
