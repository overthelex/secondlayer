/**
 * Test Email Route
 * Separate route for testing email functionality
 */

import { Router, Response } from 'express';
import { EmailService } from '../services/email-service.js';
import { logger } from '../utils/logger.js';

export function createTestEmailRoute(emailService: EmailService): Router {
  const router = Router();

  /**
   * @route   POST /api/billing/test-email
   * @desc    Send test email to verify email service configuration
   * @access  Protected (JWT required)
   */
  router.post('/', async (req: any, res: Response) => {
    try {
      const userEmail = req.user?.email;
      const userName = req.user?.name || 'User';

      if (!userEmail) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'User email not found in JWT token',
        });
      }

      // Send test email using payment success template
      await emailService.sendPaymentSuccess({
        email: userEmail,
        name: userName,
        amount: 25.00,
        currency: 'USD',
        paymentId: 'TEST-' + Date.now(),
        newBalance: 100.00,
      });

      logger.info('Test email sent successfully', { email: userEmail });

      return res.json({
        success: true,
        message: `Test email sent to ${userEmail}`,
        recipient: userEmail,
      });
    } catch (error: any) {
      logger.error('Failed to send test email', {
        error: error.message,
        stack: error.stack,
      });
      return res.status(500).json({
        error: 'Failed to send test email',
        message: error.message,
      });
    }
  });

  return router;
}
