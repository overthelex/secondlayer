/**
 * Fondy Payment Service
 * Handles Fondy (Ukrainian payment gateway) integration
 */

import crypto from 'crypto';
import axios from 'axios';
import { BillingService } from './billing-service.js';
import { EmailService } from './email-service.js';
import { invoiceService } from './invoice-service.js';
import { logger } from '../utils/logger.js';

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
  [key: string]: string;
}

export interface FondyPaymentStatus {
  status: 'approved' | 'declined' | 'processing' | 'reversed' | 'pending';
  amount: number;
  currency: string;
  orderId: string;
}

export class FondyService {
  private merchantId: string;
  private secretKey: string;
  private apiUrl: string;

  constructor(
    private billingService: BillingService,
    private emailService: EmailService
  ) {
    this.merchantId = process.env.FONDY_MERCHANT_ID || '';
    this.secretKey = process.env.FONDY_SECRET_KEY || '';
    this.apiUrl = process.env.FONDY_API_URL || 'https://pay.fondy.eu/api';

    if (!this.merchantId || !this.secretKey) {
      logger.warn('Fondy credentials not configured (UAH payments disabled)');
    } else {
      logger.info('FondyService initialized', {
        merchantId: this.merchantId,
      });
    }
  }

  /**
   * Create Fondy payment
   */
  async createPayment(
    userId: string,
    amountUah: number,
    email: string,
    orderId: string,
    description: string
  ): Promise<FondyPaymentResult> {
    try {
      if (!this.merchantId || !this.secretKey) {
        throw new Error('Fondy is not configured');
      }

      // Validate amount (minimum 10 UAH)
      if (amountUah < 10) {
        throw new Error('Minimum top-up amount is 10 UAH');
      }

      // Convert to kopiykas (cents)
      const amountKopiykas = Math.round(amountUah * 100);

      // Prepare payment data
      const paymentData: any = {
        order_id: orderId,
        merchant_id: this.merchantId,
        order_desc: description,
        amount: amountKopiykas.toString(),
        currency: 'UAH',
        response_url: `${process.env.FRONTEND_URL}/payment/result`,
        server_callback_url: `${process.env.BACKEND_URL}/webhooks/fondy`,
        sender_email: email,
        merchant_data: JSON.stringify({
          user_id: userId,
          type: 'balance_topup',
        }),
      };

      // Generate signature
      paymentData.signature = this.generateSignature(paymentData);

      // Make API request
      const response = await axios.post(`${this.apiUrl}/checkout/url/`, {
        request: paymentData,
      });

      if (response.data.response.response_status !== 'success') {
        throw new Error(
          response.data.response.error_message || 'Fondy API error'
        );
      }

      const checkoutUrl = response.data.response.checkout_url;

      logger.info('Fondy payment created', {
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
    } catch (error: any) {
      logger.error('Failed to create Fondy payment', {
        userId,
        amountUah,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Handle Fondy callback
   */
  async handleCallback(callbackData: FondyCallbackData): Promise<void> {
    try {
      const orderId = callbackData.order_id;
      const status = callbackData.order_status;
      const amount = parseInt(callbackData.amount, 10) / 100; // Convert from kopiykas
      const signature = callbackData.signature;

      // Verify signature
      const isValid = this.verifySignature(callbackData, signature);
      if (!isValid) {
        throw new Error('Invalid Fondy callback signature');
      }

      logger.info('Fondy callback received', {
        orderId,
        status,
        amount,
      });

      // Handle based on status
      if (status === 'approved') {
        await this.handlePaymentSuccess(callbackData);
      } else if (status === 'declined' || status === 'reversed') {
        await this.handlePaymentFailure(callbackData);
      }
    } catch (error: any) {
      logger.error('Failed to process Fondy callback', {
        orderId: callbackData.order_id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Handle successful payment
   */
  private async handlePaymentSuccess(callbackData: FondyCallbackData): Promise<void> {
    try {
      const orderId = callbackData.order_id;
      const amountUah = parseInt(callbackData.amount, 10) / 100;

      // Parse merchant data to get user_id
      const merchantData = JSON.parse(callbackData.merchant_data || '{}');
      const userId = merchantData.user_id;

      if (!userId) {
        throw new Error('Missing user_id in merchant_data');
      }

      // Check for duplicate processing
      const existingTransaction = await this.checkExistingTransaction(orderId);
      if (existingTransaction) {
        logger.warn('Payment already processed (duplicate callback)', {
          orderId,
        });
        return;
      }

      // Convert UAH to USD (approximate rate, should be fetched from API in production)
      const uahToUsdRate = parseFloat(process.env.UAH_TO_USD_RATE || '0.027');
      const amountUsd = amountUah * uahToUsdRate;

      // Top up balance
      const transaction = await this.billingService.topUpBalance({
        userId,
        amountUsd,
        amountUah,
        description: `Fondy payment: ${orderId}`,
        paymentProvider: 'fondy',
        paymentId: orderId,
        metadata: {
          fondy_order_id: orderId,
          fondy_status: callbackData.order_status,
        },
      });

      // Generate invoice number for this transaction
      const invoiceNumber = invoiceService.generateInvoiceNumber(transaction.id);
      await this.billingService.setTransactionInvoiceNumber(transaction.id, invoiceNumber);

      logger.info('Balance topped up via Fondy', {
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
      logger.error('Failed to process successful Fondy payment', {
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
    try {
      const orderId = callbackData.order_id;
      const amountUah = parseInt(callbackData.amount, 10) / 100;

      logger.warn('Fondy payment failed', {
        orderId,
        amountUah,
        status: callbackData.order_status,
      });

      // Parse merchant data
      const merchantData = JSON.parse(callbackData.merchant_data || '{}');

      // Send failure notification
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
    } catch (error: any) {
      logger.error('Failed to process Fondy payment failure notification', {
        orderId: callbackData.order_id,
        error: error.message,
      });
    }
  }

  /**
   * Generate Fondy signature
   */
  private generateSignature(data: Record<string, string>): string {
    // Remove signature field if present
    const { signature, ...dataWithoutSignature } = data;

    // Sort keys alphabetically
    const sortedKeys = Object.keys(dataWithoutSignature).sort();

    // Build string: secret_key|value1|value2|...
    const values = sortedKeys.map((key) => dataWithoutSignature[key]);
    const signatureString = [this.secretKey, ...values].join('|');

    // Generate SHA-1 hash
    return crypto.createHash('sha1').update(signatureString).digest('hex');
  }

  /**
   * Verify Fondy callback signature
   */
  private verifySignature(data: FondyCallbackData, receivedSignature: string): boolean {
    const calculatedSignature = this.generateSignature(data);
    return calculatedSignature === receivedSignature;
  }

  /**
   * Get payment status
   */
  async getPaymentStatus(orderId: string): Promise<FondyPaymentStatus> {
    try {
      const requestData: any = {
        order_id: orderId,
        merchant_id: this.merchantId,
      };

      requestData.signature = this.generateSignature(requestData);

      const response = await axios.post(`${this.apiUrl}/status/order_id/`, {
        request: requestData,
      });

      if (response.data.response.response_status !== 'success') {
        throw new Error(
          response.data.response.error_message || 'Fondy API error'
        );
      }

      const orderData = response.data.response;

      return {
        status: orderData.order_status,
        amount: parseInt(orderData.amount, 10) / 100,
        currency: orderData.currency,
        orderId,
      };
    } catch (error: any) {
      logger.error('Failed to get Fondy payment status', {
        orderId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Check if transaction already exists (idempotency)
   */
  private async checkExistingTransaction(orderId: string): Promise<boolean> {
    // This will be implemented via database query
    return false;
  }
}
