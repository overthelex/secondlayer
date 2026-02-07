/**
 * Create Vovkes User Account
 * Creates user vovkes@legal.org.ua with $1000 balance
 */

import { Database } from '../database/database.js';
import { CreditService } from '../services/credit-service.js';
import { logger } from '../utils/logger.js';

const USER_DATA = {
  email: 'vovkes@legal.org.ua',
  name: 'Vovkes Admin',
  googleId: `vovkes-google-id-${Date.now()}`,
  picture: 'https://via.placeholder.com/150',
  balance: 1000.00, // $1000 USD
};

async function createVovkesUser() {
  const db = new Database();

  try {
    await db.connect();
    logger.info('🚀 Creating Vovkes user account...');

    // 1. Check if user already exists
    const existingUser = await db.query(
      'SELECT id FROM users WHERE email = $1',
      [USER_DATA.email]
    );

    let userId: string;

    if (existingUser.rows.length > 0) {
      userId = existingUser.rows[0].id;
      logger.info(`✓ User already exists: ${USER_DATA.email} (ID: ${userId})`);
    } else {
      // Create user
      const userResult = await db.query(
        `INSERT INTO users (email, name, google_id, picture, email_verified)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id`,
        [USER_DATA.email, USER_DATA.name, USER_DATA.googleId, USER_DATA.picture]
      );

      userId = userResult.rows[0].id;
      logger.info(`✓ Created user: ${USER_DATA.email} (ID: ${userId})`);
    }

    // 2. Initialize credits using CreditService
    const creditService = new CreditService(db.getPool());

    // Check current balance
    const currentBalance = await creditService.checkBalance(userId, 0);
    logger.info(`   Current balance: ${currentBalance.currentBalance} credits`);

    // Add credits (convert USD to credits, 1 USD = 1 credit for simplicity)
    const creditsToAdd = USER_DATA.balance;

    const result = await creditService.addCredits(
      userId,
      creditsToAdd,
      'bonus', // transaction type
      'manual_grant', // source
      'initial-balance-vovkes', // source ID
      `Initial balance for Vovkes admin account ($${USER_DATA.balance})`,
      undefined // no stripe payment intent
    );

    logger.info('✅ Credits added successfully!');
    logger.info(`   New balance: ${result.newBalance} credits`);
    logger.info(`   Transaction ID: ${result.transactionId}`);

    // 3. Create billing record if using legacy billing system
    const existingBilling = await db.query(
      'SELECT id FROM user_billing WHERE user_id = $1',
      [userId]
    );

    if (existingBilling.rows.length === 0) {
      await db.query(
        `INSERT INTO user_billing (
          user_id, balance_usd, balance_uah,
          daily_limit_usd, monthly_limit_usd,
          total_spent_usd, total_requests, is_active, billing_enabled
        )
        VALUES ($1, $2, 0, 1000.00, 10000.00, 0, 0, true, true)`,
        [userId, USER_DATA.balance]
      );
      logger.info(`✓ Created billing record with high limits`);
    }

    // 4. Display summary
    logger.info('\n📊 User Account Summary:');
    logger.info('═══════════════════════════════════════');
    logger.info(`   Email:        ${USER_DATA.email}`);
    logger.info(`   Name:         ${USER_DATA.name}`);
    logger.info(`   User ID:      ${userId}`);
    logger.info(`   Balance:      ${result.newBalance} credits ($${USER_DATA.balance} USD)`);
    logger.info(`   Daily Limit:  $1000.00`);
    logger.info(`   Monthly Limit: $10,000.00`);
    logger.info('═══════════════════════════════════════\n');

    logger.info('✅ Vovkes user account created successfully!\n');

    // Return user info for further use
    return {
      userId,
      email: USER_DATA.email,
      balance: result.newBalance,
    };
  } catch (error: any) {
    logger.error('❌ Error creating Vovkes user:', error);
    throw error;
  } finally {
    await db.close();
  }
}

// Run
createVovkesUser()
  .then((result) => {
    console.log('\n🎉 User ready to use MCP tools!');
    console.log(`   User ID: ${result.userId}`);
    console.log(`   Email: ${result.email}`);
    console.log(`   Balance: ${result.balance} credits\n`);
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });
