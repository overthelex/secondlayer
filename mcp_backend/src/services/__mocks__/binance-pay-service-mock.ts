/**
 * Mock Binance Pay Service for Development/Testing
 */

import { BillingService } from '../billing-service.js';
import { EmailService } from '../email-service.js';
import { invoiceService } from '../invoice-service.js';
import { logger } from '../../utils/logger.js';

export interface BinancePayOrderResult {
  orderId: string;
  paymentIntentId: string;
  qrcodeLink: string;
  universalUrl: string;
  amountUsd: number;
}

export class MockBinancePayService {
  private mockOrders: Map<string, any> = new Map();

  constructor(
    private billingService: BillingService,
    private emailService: EmailService
  ) {
    logger.info('MockBinancePayService initialized (TEST MODE)');
  }

  async createOrder(
    userId: string,
    amountUsd: number,
    email: string
  ): Promise<BinancePayOrderResult> {
    if (amountUsd < 1) {
      throw new Error('Minimum top-up amount is $1.00');
    }

    const orderId = `bp_mock_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const paymentIntentId = orderId;

    this.mockOrders.set(orderId, {
      userId,
      amountUsd,
      email,
      status: 'pending',
    });

    logger.info('[MOCK] Binance Pay order created', { orderId, userId, amountUsd });

    return {
      orderId,
      paymentIntentId,
      qrcodeLink: `https://mock-binance-pay.example.com/qr/${orderId}`,
      universalUrl: `https://mock-binance-pay.example.com/pay/${orderId}`,
      amountUsd,
    };
  }

  async handleWebhook(
    payload: any,
    headers: Record<string, string>
  ): Promise<{ received: boolean }> {
    logger.info('[MOCK] Binance Pay webhook received (signature not verified in mock mode)');

    // In mock mode, simulate success for any webhook
    const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const orderId = data?.data?.merchantTradeNo || data?.orderId;

    if (orderId && this.mockOrders.has(orderId)) {
      const order = this.mockOrders.get(orderId);
      if (order.status !== 'succeeded') {
        order.status = 'succeeded';
        this.mockOrders.set(orderId, order);

        const transaction = await this.billingService.topUpBalance({
          userId: order.userId,
          amountUsd: order.amountUsd,
          description: `[MOCK] Binance Pay payment: ${orderId}`,
          paymentProvider: 'binance_pay_mock',
          paymentId: orderId,
          metadata: { orderId },
        });

        const invoiceNumber = invoiceService.generateInvoiceNumber(transaction.id);
        await this.billingService.setTransactionInvoiceNumber(transaction.id, invoiceNumber);

        logger.info('[MOCK] Binance Pay payment succeeded', { orderId, amountUsd: order.amountUsd });
      }
    }

    return { received: true };
  }

  async getPaymentStatus(paymentIntentId: string): Promise<{ status: string; amount: number; currency: string }> {
    const order = this.mockOrders.get(paymentIntentId);
    if (!order) {
      throw new Error('Payment order not found');
    }

    return {
      status: order.status,
      amount: order.amountUsd,
      currency: 'usd',
    };
  }

  /**
   * Mock-only: simulate successful payment (for testing)
   */
  async simulatePaymentSuccess(orderId: string): Promise<void> {
    const order = this.mockOrders.get(orderId);
    if (!order) {
      throw new Error('Order not found');
    }

    await this.handleWebhook(
      { bizType: 'PAY', bizStatus: 'PAY_SUCCESS', data: { merchantTradeNo: orderId } },
      { 'binancepay-timestamp': String(Date.now()), 'binancepay-nonce': 'mock', 'binancepay-signature': 'mock' }
    );
  }
}
