/**
 * Mock Stripe Service for Development/Testing
 * Simulates Stripe payment flow without actual API calls
 */

import { BillingService } from '../billing-service.js';
import { EmailService } from '../email-service.js';
import { logger } from '../../utils/logger.js';

export interface PaymentIntentResult {
  clientSecret: string;
  paymentIntentId: string;
  amount: number;
  currency: string;
}

export interface PaymentStatus {
  status: 'succeeded' | 'processing' | 'requires_payment_method' | 'canceled' | 'failed';
  amount: number;
  currency: string;
  metadata?: any;
}

export class MockStripeService {
  private mockPayments: Map<string, any> = new Map();

  constructor(
    private billingService: BillingService,
    private emailService: EmailService
  ) {
    logger.info('MockStripeService initialized (TEST MODE)');
  }

  /**
   * Mock: Create a Payment Intent
   */
  async createPaymentIntent(
    userId: string,
    amountUsd: number,
    email: string,
    metadata?: Record<string, string>
  ): Promise<PaymentIntentResult> {
    // Validate amount
    if (amountUsd < 1) {
      throw new Error('Minimum top-up amount is $1.00');
    }

    // Generate mock payment intent ID
    const paymentIntentId = `pi_mock_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const clientSecret = `${paymentIntentId}_secret_${Math.random().toString(36).substring(7)}`;

    // Store mock payment
    this.mockPayments.set(paymentIntentId, {
      id: paymentIntentId,
      amount: amountUsd * 100,
      currency: 'usd',
      status: 'requires_payment_method',
      metadata: {
        user_id: userId,
        type: 'balance_topup',
        ...metadata,
      },
      receipt_email: email,
      created: Date.now(),
    });

    logger.info('[MOCK] Stripe PaymentIntent created', {
      userId,
      amountUsd,
      paymentIntentId,
    });

    return {
      clientSecret,
      paymentIntentId,
      amount: amountUsd,
      currency: 'usd',
    };
  }

  /**
   * Mock: Handle webhook (simulated)
   */
  async handleWebhook(payload: Buffer, signature: string): Promise<{ received: boolean; event?: string }> {
    logger.info('[MOCK] Stripe webhook received (signature not verified in mock mode)');

    // In mock mode, we don't actually verify signatures
    // Parse payload as JSON
    const event = JSON.parse(payload.toString('utf8'));

    // Handle event
    switch (event.type) {
      case 'payment_intent.succeeded':
        await this.handlePaymentSuccess(event.data.object);
        break;
      case 'payment_intent.payment_failed':
        await this.handlePaymentFailure(event.data.object);
        break;
    }

    return { received: true, event: event.type };
  }

  /**
   * Mock: Simulate successful payment
   */
  async simulatePaymentSuccess(paymentIntentId: string): Promise<void> {
    const payment = this.mockPayments.get(paymentIntentId);
    if (!payment) {
      throw new Error('Payment intent not found');
    }

    payment.status = 'succeeded';
    this.mockPayments.set(paymentIntentId, payment);

    await this.handlePaymentSuccess(payment);

    logger.info('[MOCK] Payment simulated as successful', { paymentIntentId });
  }

  /**
   * Handle successful payment
   */
  private async handlePaymentSuccess(paymentIntent: any): Promise<void> {
    try {
      const userId = paymentIntent.metadata.user_id;
      const amountUsd = paymentIntent.amount / 100;

      if (!userId) {
        throw new Error('Missing user_id in PaymentIntent metadata');
      }

      // Check for duplicate processing
      const existingTx = await this.checkExistingTransaction(paymentIntent.id);
      if (existingTx) {
        logger.warn('[MOCK] Payment already processed (duplicate)', {
          paymentIntentId: paymentIntent.id,
        });
        return;
      }

      // Top up balance
      const transaction = await this.billingService.topUpBalance({
        userId,
        amountUsd,
        description: `[MOCK] Stripe payment: ${paymentIntent.id}`,
        paymentProvider: 'stripe_mock',
        paymentId: paymentIntent.id,
        metadata: paymentIntent.metadata,
      });

      logger.info('[MOCK] Balance topped up via Stripe', {
        userId,
        amountUsd,
        transactionId: transaction.id,
        paymentIntentId: paymentIntent.id,
      });

      // Send confirmation email
      if (paymentIntent.receipt_email) {
        await this.emailService.sendPaymentSuccess({
          email: paymentIntent.receipt_email,
          name: paymentIntent.metadata.user_name || 'User',
          amount: amountUsd,
          currency: 'USD',
          newBalance: transaction.balance_after_usd,
          paymentId: paymentIntent.id,
        });
      }
    } catch (error: any) {
      logger.error('[MOCK] Failed to process successful payment', {
        paymentIntentId: paymentIntent.id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Handle failed payment
   */
  private async handlePaymentFailure(paymentIntent: any): Promise<void> {
    const userId = paymentIntent.metadata.user_id;
    const amountUsd = paymentIntent.amount / 100;

    logger.warn('[MOCK] Stripe payment failed', {
      userId,
      amountUsd,
      paymentIntentId: paymentIntent.id,
    });

    if (paymentIntent.receipt_email) {
      await this.emailService.sendPaymentFailure({
        email: paymentIntent.receipt_email,
        name: paymentIntent.metadata.user_name || 'User',
        amount: amountUsd,
        currency: 'USD',
        reason: 'Mock payment failure',
      });
    }
  }

  /**
   * Get payment status
   */
  async getPaymentStatus(paymentIntentId: string): Promise<PaymentStatus> {
    const payment = this.mockPayments.get(paymentIntentId);

    if (!payment) {
      throw new Error('Payment intent not found');
    }

    return {
      status: payment.status,
      amount: payment.amount / 100,
      currency: payment.currency,
      metadata: payment.metadata,
    };
  }

  /**
   * Check if transaction already exists
   */
  private async checkExistingTransaction(paymentId: string): Promise<boolean> {
    // TODO: Check in database via billing service
    return false;
  }
}
