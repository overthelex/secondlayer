/**
 * Add Credits to ChatGPT OAuth User
 * Quick script to grant credits for testing ChatGPT MCP integration
 */

import { Database } from '../database/database.js';
import { CreditService } from '../services/credit-service.js';
import { logger } from '../utils/logger.js';

const CHATGPT_USER_ID = 'abfa4cd8-61de-4908-a778-4d23c1574f0a';
const CREDITS_TO_ADD = parseFloat(process.env.CREDITS || '100');

async function addCredits() {
  const db = new Database();

  try {
    await db.connect();
    const creditService = new CreditService(db.getPool());

    logger.info('💳 Adding credits to ChatGPT user...');
    logger.info(`   User ID: ${CHATGPT_USER_ID}`);
    logger.info(`   Credits: ${CREDITS_TO_ADD}`);

    // Check current balance
    const balanceBefore = await creditService.checkBalance(CHATGPT_USER_ID, 0);
    logger.info(`   Current balance: ${balanceBefore.currentBalance}`);

    // Add credits
    const result = await creditService.addCredits(
      CHATGPT_USER_ID,
      CREDITS_TO_ADD,
      'bonus', // transaction type
      'manual_grant', // source
      'chatgpt-integration-test', // source ID
      'Initial credits for ChatGPT MCP integration testing'
    );

    logger.info('✅ Credits added successfully!');
    logger.info(`   New balance: ${result.newBalance}`);
    logger.info(`   Transaction ID: ${result.transactionId}`);

    // Verify final balance
    const balanceAfter = await creditService.checkBalance(CHATGPT_USER_ID, 1);
    logger.info(`   Has credits for tool call: ${balanceAfter.hasCredits}`);

    // Get user info
    const userInfo = await db.query(
      'SELECT email, name FROM users WHERE id = $1',
      [CHATGPT_USER_ID]
    );

    if (userInfo.rows.length > 0) {
      logger.info(`   User: ${userInfo.rows[0].name} (${userInfo.rows[0].email})`);
    }

    logger.info('\n🎉 ChatGPT user is ready to use MCP tools!');
  } catch (error: any) {
    logger.error('❌ Error adding credits:', error);
    throw error;
  } finally {
    await db.close();
  }
}

// Run
addCredits()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });
