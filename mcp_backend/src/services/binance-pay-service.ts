/**
 * Binance Pay Service
 * Handles Binance Pay orders and webhook verification via HMAC-SHA512
 */

import crypto from 'crypto';
import { BillingService } from './billing-service.js';
import { EmailService } from './email-service.js';
import { invoiceService } from './invoice-service.js';
import { logger } from '../utils/logger.js';
import { BaseDatabase } from '@secondlayer/shared';

const BINANCE_PAY_API = 'https://bpay.binanceapi.com';

export interface BinancePayOrderResult {
  orderId: string;
  paymentIntentId: string;
  qrcodeLink: string;
  universalUrl: string;
  amountUsd: number;
}

export class BinancePayService {
  private apiKey: string;
  private secretKey: string;
  private merchantId: string;

  constructor(
    private billingService: BillingService,
    private emailService: EmailService,
    private db: BaseDatabase
  ) {
    this.apiKey = process.env.BINANCE_PAY_API_KEY || '';
    this.secretKey = process.env.BINANCE_PAY_SECRET_KEY || '';
    this.merchantId = process.env.BINANCE_PAY_MERCHANT_ID || '';

    if (!this.apiKey || !this.secretKey) {
      throw new Error('BINANCE_PAY_API_KEY and BINANCE_PAY_SECRET_KEY are required');
    }

    logger.info('BinancePayService initialized', {
      merchantId: this.merchantId,
    });
  }

  /**
   * Create a Binance Pay order
   */
  async createOrder(
    userId: string,
    amountUsd: number,
    email: string
  ): Promise<BinancePayOrderResult> {
    if (amountUsd < 1) {
      throw new Error('Minimum top-up amount is $1.00');
    }

    const timestamp = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const merchantTradeNo = `SL-${userId.substring(0, 8)}-${timestamp}`;

    const body = {
      env: { terminalType: 'WEB' },
      merchantTradeNo,
      orderAmount: amountUsd.toFixed(2),
      currency: 'USDT',
      goods: {
        goodsType: '02', // virtual goods
        goodsCategory: 'Z000', // others
        referenceGoodsId: 'balance_topup',
        goodsName: 'SecondLayer Balance Top-up',
      },
      returnUrl: process.env.BINANCE_PAY_RETURN_URL || `${process.env.APP_URL || 'https://stage.legal.org.ua'}/billing?tab=topup`,
      webhookUrl: process.env.BINANCE_PAY_WEBHOOK_URL || `${process.env.APP_URL || 'https://stage.legal.org.ua'}/webhooks/binance-pay`,
    };

    const bodyString = JSON.stringify(body);
    const payload = `${timestamp}\n${nonce}\n${bodyString}\n`;
    const signature = crypto
      .createHmac('sha512', this.secretKey)
      .update(payload)
      .digest('hex')
      .toUpperCase();

    const response = await fetch(`${BINANCE_PAY_API}/binancepay/openapi/v2/order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'BinancePay-Timestamp': String(timestamp),
        'BinancePay-Nonce': nonce,
        'BinancePay-Certificate-SN': this.apiKey,
        'BinancePay-Signature': signature,
      },
      body: bodyString,
    });

    const data = await response.json() as any;

    if (data.status !== 'SUCCESS') {
      logger.error('Binance Pay order creation failed', { response: data });
      throw new Error(`Binance Pay error: ${data.errorMessage || 'Unknown error'}`);
    }

    // Store in payment_intents
    const externalId = data.data.prepayId || merchantTradeNo;
    const insertResult = await this.db.query(
      `INSERT INTO payment_intents
        (user_id, provider, external_id, amount_usd, status, crypto_token, metadata)
       VALUES ($1, 'binance_pay', $2, $3, 'pending', 'usdt', $4)
       RETURNING id`,
      [userId, externalId, amountUsd, JSON.stringify({ email, merchantTradeNo })]
    );

    const paymentIntentId = insertResult.rows[0].id;

    logger.info('Binance Pay order created', {
      paymentIntentId,
      userId,
      amountUsd,
      merchantTradeNo,
      prepayId: data.data.prepayId,
    });

    return {
      orderId: externalId,
      paymentIntentId,
      qrcodeLink: data.data.qrcodeLink,
      universalUrl: data.data.universalUrl,
      amountUsd,
    };
  }

  /**
   * Handle Binance Pay webhook callback
   */
  async handleWebhook(
    payload: any,
    headers: Record<string, string>
  ): Promise<{ received: boolean }> {
    // Verify signature
    const timestamp = headers['binancepay-timestamp'];
    const nonce = headers['binancepay-nonce'];
    const signature = headers['binancepay-signature'];

    if (!timestamp || !nonce || !signature) {
      throw new Error('Missing Binance Pay webhook signature headers');
    }

    const bodyString = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const signPayload = `${timestamp}\n${nonce}\n${bodyString}\n`;
    const expectedSignature = crypto
      .createHmac('sha512', this.secretKey)
      .update(signPayload)
      .digest('hex')
      .toUpperCase();

    if (signature.toUpperCase() !== expectedSignature) {
      throw new Error('Invalid Binance Pay webhook signature');
    }

    const data = typeof payload === 'string' ? JSON.parse(payload) : payload;

    if (data.bizType === 'PAY' && data.bizStatus === 'PAY_SUCCESS') {
      const orderData = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
      const prepayId = orderData.prepayId || orderData.merchantTradeNo;

      // Find the payment intent
      const piResult = await this.db.query(
        'SELECT * FROM payment_intents WHERE external_id = $1 AND provider = $2',
        [prepayId, 'binance_pay']
      );

      if (piResult.rows.length === 0) {
        logger.warn('Binance Pay webhook: payment intent not found', { prepayId });
        return { received: true };
      }

      const pi = piResult.rows[0];

      if (pi.status === 'succeeded') {
        logger.warn('Binance Pay webhook: already processed', { prepayId });
        return { received: true };
      }

      // Mark succeeded
      await this.db.query(
        'UPDATE payment_intents SET status = $1, updated_at = NOW() WHERE id = $2',
        ['succeeded', pi.id]
      );

      // Credit balance
      const transaction = await this.billingService.topUpBalance({
        userId: pi.user_id,
        amountUsd: parseFloat(pi.amount_usd),
        description: `Binance Pay payment: ${prepayId}`,
        paymentProvider: 'binance_pay',
        paymentId: pi.id,
        metadata: { prepayId },
      });

      const invoiceNumber = invoiceService.generateInvoiceNumber(transaction.id);
      await this.billingService.setTransactionInvoiceNumber(transaction.id, invoiceNumber);

      logger.info('Binance Pay payment succeeded', {
        paymentIntentId: pi.id,
        amountUsd: pi.amount_usd,
        transactionId: transaction.id,
      });

      // Send email
      const metadata = JSON.parse(pi.metadata || '{}');
      if (metadata.email) {
        await this.emailService.sendPaymentSuccess({
          email: metadata.email,
          name: 'User',
          amount: parseFloat(pi.amount_usd),
          currency: 'USD',
          newBalance: transaction.balance_after_usd,
          paymentId: pi.id,
          userId: pi.user_id,
        });
      }
    }

    return { received: true };
  }

  /**
   * Get payment status
   */
  async getPaymentStatus(paymentIntentId: string): Promise<{ status: string; amount: number; currency: string }> {
    const result = await this.db.query(
      'SELECT status, amount_usd FROM payment_intents WHERE id = $1 AND provider = $2',
      [paymentIntentId, 'binance_pay']
    );

    if (result.rows.length === 0) {
      throw new Error('Payment order not found');
    }

    return {
      status: result.rows[0].status,
      amount: parseFloat(result.rows[0].amount_usd),
      currency: 'usd',
    };
  }
}
