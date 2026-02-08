/**
 * Mock Fondy Service for Development/Testing
 * Simulates Fondy payment flow without actual API calls
 */

import crypto from 'crypto';
import { BillingService } from '../billing-service.js';
import { EmailService } from '../email-service.js';
import { invoiceService } from '../invoice-service.js';
import { logger } from '../../utils/logger.js';

export interface FondyPaymentResult {
  paymentUrl: string;
  orderId: string;
  amount: number;
  currency: string;
}

export interface FondyCallbackData {
  order_id: string;
  order_status: string;
  amount: string;
  currency: string;
  signature: string;
  merchant_data?: string;
  sender_email?: string;
  response_description?: string;
  [key: string]: string | undefined;
}

export interface FondyPaymentStatus {
  status: 'approved' | 'declined' | 'processing' | 'reversed' | 'pending';
  amount: number;
  currency: string;
  orderId: string;
}

export class MockFondyService {
  private mockPayments: Map<string, any> = new Map();
  private secretKey = 'mock_fondy_secret';

  constructor(
    private billingService: BillingService,
    private emailService: EmailService
  ) {
    logger.info('MockFondyService initialized (TEST MODE)');
  }

  /**
   * Mock: Create Fondy payment
   */
  async createPayment(
    userId: string,
    amountUah: number,
    email: string,
    orderId: string,
    description: string
  ): Promise<FondyPaymentResult> {
    // Validate amount
    if (amountUah < 10) {
      throw new Error('Minimum top-up amount is 10 UAH');
    }

    // Convert to kopiykas
    const amountKopiykas = Math.round(amountUah * 100);

    // Store mock payment
    this.mockPayments.set(orderId, {
      order_id: orderId,
      amount: amountKopiykas.toString(),
      currency: 'UAH',
      order_status: 'pending',
      merchant_data: JSON.stringify({
        user_id: userId,
        type: 'balance_topup',
      }),
      sender_email: email,
      created: Date.now(),
    });

    // Generate mock checkout URL
    const checkoutUrl = `http://localhost:3000/mock/fondy/checkout?order_id=${orderId}`;

    logger.info('[MOCK] Fondy payment created', {
      userId,
      orderId,
      amountUah,
    });

    return {
      paymentUrl: checkoutUrl,
      orderId,
      amount: amountUah,
      currency: 'UAH',
    };
  }

  /**
   * Mock: Handle Fondy callback
   */
  async handleCallback(callbackData: FondyCallbackData): Promise<void> {
    try {
      const orderId = callbackData.order_id;
      const status = callbackData.order_status;
      const amount = parseInt(callbackData.amount, 10) / 100;

      logger.info('[MOCK] Fondy callback received', {
        orderId,
        status,
        amount,
      });

      // In mock mode, we don't verify signatures strictly
      // Just log that we would verify it
      logger.debug('[MOCK] Signature verification skipped in mock mode');

      // Handle based on status
      if (status === 'approved') {
        await this.handlePaymentSuccess(callbackData);
      } else if (status === 'declined' || status === 'reversed') {
        await this.handlePaymentFailure(callbackData);
      }
    } catch (error: any) {
      logger.error('[MOCK] Failed to process Fondy callback', {
        orderId: callbackData.order_id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Mock: Simulate successful payment
   */
  async simulatePaymentSuccess(orderId: string): Promise<void> {
    const payment = this.mockPayments.get(orderId);
    if (!payment) {
      throw new Error('Order not found');
    }

    payment.order_status = 'approved';
    this.mockPayments.set(orderId, payment);

    // Generate callback data
    const callbackData: FondyCallbackData = {
      order_id: orderId,
      order_status: 'approved',
      amount: payment.amount,
      currency: payment.currency,
      merchant_data: payment.merchant_data,
      sender_email: payment.sender_email,
      signature: 'mock_signature',
    };

    await this.handleCallback(callbackData);

    logger.info('[MOCK] Fondy payment simulated as successful', { orderId });
  }

  /**
   * Handle successful payment
   */
  private async handlePaymentSuccess(callbackData: FondyCallbackData): Promise<void> {
    try {
      const orderId = callbackData.order_id;
      const amountUah = parseInt(callbackData.amount, 10) / 100;

      // Parse merchant data
      const merchantData = JSON.parse(callbackData.merchant_data || '{}');
      const userId = merchantData.user_id;

      if (!userId) {
        throw new Error('Missing user_id in merchant_data');
      }

      // Check for duplicate
      const existingTx = await this.checkExistingTransaction(orderId);
      if (existingTx) {
        logger.warn('[MOCK] Payment already processed (duplicate callback)', {
          orderId,
        });
        return;
      }

      // Convert UAH to USD (mock rate)
      const uahToUsdRate = parseFloat(process.env.UAH_TO_USD_RATE || '0.027');
      const amountUsd = amountUah * uahToUsdRate;

      // Top up balance
      const transaction = await this.billingService.topUpBalance({
        userId,
        amountUsd,
        amountUah,
        description: `[MOCK] Fondy payment: ${orderId}`,
        paymentProvider: 'fondy_mock',
        paymentId: orderId,
        metadata: {
          fondy_order_id: orderId,
          fondy_status: callbackData.order_status,
        },
      });

      // Generate invoice number
      const invoiceNumber = invoiceService.generateInvoiceNumber(transaction.id);
      await this.billingService.setTransactionInvoiceNumber(transaction.id, invoiceNumber);

      logger.info('[MOCK] Balance topped up via Fondy', {
        userId,
        amountUah,
        amountUsd,
        transactionId: transaction.id,
        orderId,
        invoiceNumber,
      });

      // Send confirmation email
      if (callbackData.sender_email) {
        await this.emailService.sendPaymentSuccess({
          email: callbackData.sender_email,
          name: merchantData.user_name || 'User',
          amount: amountUah,
          currency: 'UAH',
          newBalance: transaction.balance_after_usd,
          paymentId: orderId,
          userId,
        });
      }
    } catch (error: any) {
      logger.error('[MOCK] Failed to process successful Fondy payment', {
        orderId: callbackData.order_id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Handle failed payment
   */
  private async handlePaymentFailure(callbackData: FondyCallbackData): Promise<void> {
    const orderId = callbackData.order_id;
    const amountUah = parseInt(callbackData.amount, 10) / 100;

    logger.warn('[MOCK] Fondy payment failed', {
      orderId,
      amountUah,
      status: callbackData.order_status,
    });

    const merchantData = JSON.parse(callbackData.merchant_data || '{}');

    if (callbackData.sender_email) {
      const userId = merchantData.user_id;
      await this.emailService.sendPaymentFailure({
        email: callbackData.sender_email,
        name: merchantData.user_name || 'User',
        amount: amountUah,
        currency: 'UAH',
        reason: callbackData.response_description || 'Payment declined',
        userId,
      });
    }
  }

  /**
   * Get payment status
   */
  async getPaymentStatus(orderId: string): Promise<FondyPaymentStatus> {
    const payment = this.mockPayments.get(orderId);

    if (!payment) {
      throw new Error('Order not found');
    }

    return {
      status: payment.order_status,
      amount: parseInt(payment.amount, 10) / 100,
      currency: payment.currency,
      orderId,
    };
  }

  /**
   * Check if transaction already exists
   */
  private async checkExistingTransaction(orderId: string): Promise<boolean> {
    // TODO: Check in database via billing service
    return false;
  }
}
