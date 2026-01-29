/**
 * Email Testing Script
 * Tests SMTP connection and sends test emails
 */

import { EmailService } from '../services/email-service.js';
import { logger } from '../utils/logger.js';

async function testEmail(recipientEmail?: string) {
  const recipient = recipientEmail || process.env.TEST_ACCOUNT_EMAIL || 'test@legal.org.ua';

  logger.info('🧪 Testing email service...');
  logger.info(`📧 Recipient: ${recipient}`);
  logger.info(`📮 SMTP Host: ${process.env.SMTP_HOST || 'not configured'}`);
  logger.info(`🔌 SMTP Port: ${process.env.SMTP_PORT || 'not configured'}`);
  logger.info(`👤 SMTP User: ${process.env.SMTP_USER || 'not configured'}`);

  const emailService = new EmailService();

  try {
    // Test 1: Payment Success Email
    logger.info('\n📨 Test 1: Sending payment success email...');
    await emailService.sendPaymentSuccess({
      email: recipient,
      name: 'Test User',
      amount: 25.00,
      currency: 'USD',
      paymentId: 'TEST-PI-' + Date.now(),
      newBalance: 100.00,
    });
    logger.info('✅ Payment success email sent!');

    // Wait a bit between emails
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Test 2: Payment Failure Email
    logger.info('\n📨 Test 2: Sending payment failure email...');
    await emailService.sendPaymentFailure({
      email: recipient,
      name: 'Test User',
      amount: 50.00,
      currency: 'USD',
      reason: 'Insufficient funds in payment method',
    });
    logger.info('✅ Payment failure email sent!');

    // Wait a bit between emails
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Test 3: Low Balance Alert
    logger.info('\n📨 Test 3: Sending low balance alert...');
    await emailService.sendLowBalanceAlert({
      email: recipient,
      name: 'Test User',
      balance: 4.75,
      currency: 'USD',
    });
    logger.info('✅ Low balance alert sent!');

    logger.info('\n✅ All test emails sent successfully!');
    logger.info(`\n📬 Check your inbox at: ${recipient}`);
    logger.info('💡 If you don\'t see the emails, check your spam folder.');
    logger.info('\n📧 Email Configuration:');
    logger.info(`   From: ${process.env.EMAIL_FROM || 'billing@legal.org.ua'}`);
    logger.info(`   Host: ${process.env.SMTP_HOST}:${process.env.SMTP_PORT}`);
    logger.info(`   Secure: ${process.env.SMTP_SECURE || 'false'}`);
    logger.info(`   User: ${process.env.SMTP_USER}`);

  } catch (error: any) {
    logger.error('\n❌ Email test failed!');
    logger.error(`Error: ${error.message}`);

    if (error.code) {
      logger.error(`Error Code: ${error.code}`);
    }

    if (error.command) {
      logger.error(`SMTP Command: ${error.command}`);
    }

    logger.error('\n🔍 Troubleshooting:');
    logger.error('1. Check that SMTP credentials are correct in .env file');
    logger.error('2. Verify SMTP_HOST and SMTP_PORT are correct');
    logger.error('3. Check if SMTP server requires authentication');
    logger.error('4. Verify firewall allows outbound connections on SMTP port');
    logger.error('5. Check SMTP_USER has permission to send emails');

    if (!process.env.SMTP_HOST) {
      logger.error('\n⚠️  SMTP_HOST is not set in environment variables!');
    }
    if (!process.env.SMTP_USER) {
      logger.error('⚠️  SMTP_USER is not set in environment variables!');
    }
    if (!process.env.SMTP_PASS) {
      logger.error('⚠️  SMTP_PASS is not set in environment variables!');
    }

    throw error;
  }
}

// Run if executed directly (when using ts-node or node directly)
// Use npm run test:email:dev to run with ts-node
const recipientEmail = process.argv[2];

testEmail(recipientEmail)
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });

export { testEmail };
