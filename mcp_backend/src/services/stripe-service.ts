/**
 * Stripe Payment Service
 * Handles Stripe payment intents and webhook processing
 */

import Stripe from 'stripe';
import { BillingService } from './billing-service.js';
import { EmailService } from './email-service.js';
import { InvoiceService, invoiceService } from './invoice-service.js';
import { logger } from '../utils/logger.js';

export interface PaymentIntentResult {
  clientSecret: string;
  paymentIntentId: string;
  amount: number;
  currency: string;
}

export interface PaymentStatus {
  status: 'succeeded' | 'processing' | 'requires_payment_method' | 'requires_action' | 'requires_capture' | 'requires_confirmation' | 'canceled' | 'failed';
  amount: number;
  currency: string;
  metadata?: any;
}

export class StripeService {
  private stripe: Stripe;
  private webhookSecret: string;

  constructor(
    private billingService: BillingService,
    private emailService: EmailService
  ) {
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    this.webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

    if (!stripeSecretKey) {
      throw new Error('STRIPE_SECRET_KEY environment variable is required');
    }

    this.stripe = new Stripe(stripeSecretKey, {
      apiVersion: '2026-01-28.clover', // Latest stable API version
    });

    logger.info('StripeService initialized', {
      webhookConfigured: !!this.webhookSecret,
    });
  }

  /**
   * Create a Payment Intent for top-up
   */
  async createPaymentIntent(
    userId: string,
    amountUsd: number,
    email: string,
    metadata?: Record<string, string>
  ): Promise<PaymentIntentResult> {
    try {
      // Validate amount (minimum $1)
      if (amountUsd < 1) {
        throw new Error('Minimum top-up amount is $1.00');
      }

      // Convert to cents
      const amountCents = Math.round(amountUsd * 100);

      // Create payment intent
      const paymentIntent = await this.stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'usd',
        receipt_email: email,
        metadata: {
          user_id: userId,
          type: 'balance_topup',
          ...metadata,
        },
        description: `Balance top-up: $${amountUsd.toFixed(2)}`,
      });

      logger.info('Stripe PaymentIntent created', {
        userId,
        amountUsd,
        paymentIntentId: paymentIntent.id,
      });

      return {
        clientSecret: paymentIntent.client_secret!,
        paymentIntentId: paymentIntent.id,
        amount: amountUsd,
        currency: 'usd',
      };
    } catch (error: any) {
      logger.error('Failed to create Stripe PaymentIntent', {
        userId,
        amountUsd,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Handle Stripe webhook events
   */
  async handleWebhook(
    payload: Buffer,
    signature: string
  ): Promise<{ received: boolean; event?: string }> {
    try {
      // Verify webhook signature
      const event = this.stripe.webhooks.constructEvent(
        payload,
        signature,
        this.webhookSecret
      );

      logger.info('Stripe webhook received', {
        type: event.type,
        id: event.id,
      });

      // Handle different event types
      switch (event.type) {
        case 'payment_intent.succeeded':
          await this.handlePaymentSuccess(event.data.object as Stripe.PaymentIntent);
          break;

        case 'payment_intent.payment_failed':
          await this.handlePaymentFailure(event.data.object as Stripe.PaymentIntent);
          break;

        case 'payment_intent.canceled':
          logger.info('PaymentIntent canceled', {
            id: event.data.object.id,
          });
          break;

        default:
          logger.debug('Unhandled webhook event type', {
            type: event.type,
          });
      }

      return { received: true, event: event.type };
    } catch (error: any) {
      logger.error('Stripe webhook verification failed', {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Handle successful payment
   */
  async handlePaymentSuccess(paymentIntent: Stripe.PaymentIntent): Promise<void> {
    try {
      const userId = paymentIntent.metadata.user_id;
      const amountUsd = paymentIntent.amount / 100;

      if (!userId) {
        throw new Error('Missing user_id in PaymentIntent metadata');
      }

      // Check for duplicate processing (idempotency)
      const existingTransaction = await this.checkExistingTransaction(paymentIntent.id);
      if (existingTransaction) {
        logger.warn('Payment already processed (duplicate webhook)', {
          paymentIntentId: paymentIntent.id,
        });
        return;
      }

      // Top up balance
      const transaction = await this.billingService.topUpBalance({
        userId,
        amountUsd,
        description: `Stripe payment: ${paymentIntent.id}`,
        paymentProvider: 'stripe',
        paymentId: paymentIntent.id,
        metadata: paymentIntent.metadata,
      });

      // Generate invoice number for this transaction
      const invoiceNumber = invoiceService.generateInvoiceNumber(transaction.id);
      await this.billingService.setTransactionInvoiceNumber(transaction.id, invoiceNumber);

      logger.info('Balance topped up via Stripe', {
        userId,
        amountUsd,
        transactionId: transaction.id,
        paymentIntentId: paymentIntent.id,
        invoiceNumber,
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
          userId,
        });
      }
    } catch (error: any) {
      logger.error('Failed to process successful payment', {
        paymentIntentId: paymentIntent.id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Handle failed payment
   */
  async handlePaymentFailure(paymentIntent: Stripe.PaymentIntent): Promise<void> {
    try {
      const userId = paymentIntent.metadata.user_id;
      const amountUsd = paymentIntent.amount / 100;

      logger.warn('Stripe payment failed', {
        userId,
        amountUsd,
        paymentIntentId: paymentIntent.id,
        lastError: paymentIntent.last_payment_error?.message,
      });

      // Send failure notification
      if (paymentIntent.receipt_email) {
        await this.emailService.sendPaymentFailure({
          email: paymentIntent.receipt_email,
          name: paymentIntent.metadata.user_name || 'User',
          amount: amountUsd,
          currency: 'USD',
          reason: paymentIntent.last_payment_error?.message || 'Unknown error',
          userId,
        });
      }
    } catch (error: any) {
      logger.error('Failed to process payment failure notification', {
        paymentIntentId: paymentIntent.id,
        error: error.message,
      });
    }
  }

  /**
   * Get payment status
   */
  async getPaymentStatus(paymentIntentId: string): Promise<PaymentStatus> {
    try {
      const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);

      return {
        status: paymentIntent.status,
        amount: paymentIntent.amount / 100,
        currency: paymentIntent.currency,
        metadata: paymentIntent.metadata,
      };
    } catch (error: any) {
      logger.error('Failed to get payment status', {
        paymentIntentId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Check if transaction already exists (idempotency)
   */
  private async checkExistingTransaction(paymentId: string): Promise<boolean> {
    // This will be implemented via database query
    // For now, we'll rely on billing service's transaction uniqueness
    return false;
  }
}
