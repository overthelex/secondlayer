/**
 * MockMonobankService
 * Dev/test stub that simulates Monobank without real API calls.
 */

import { logger } from '../../utils/logger.js';
import { MonobankService, MonobankInvoiceResult, MonobankPaymentStatus, MonobankWebhookBody } from '../monobank-service.js';

export class MockMonobankService extends MonobankService {
  async createInvoice(
    userId: string,
    amountUah: number,
    description: string,
    redirectUrl?: string
  ): Promise<MonobankInvoiceResult> {
    const invoiceId = `mock-mono-${Date.now()}-${userId.substring(0, 8)}`;
    const pageUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payment/success?mock=true&invoiceId=${invoiceId}`;

    logger.info('[MockMonobankService] Created mock invoice', { userId, amountUah, invoiceId });

    return { invoiceId, pageUrl };
  }

  async handleWebhook(_rawBody: Buffer | string, body: MonobankWebhookBody, _signature: string): Promise<{ received: boolean }> {
    logger.info('[MockMonobankService] Mock webhook received', { invoiceId: body.invoiceId, status: body.status });
    return { received: true };
  }

  async getPaymentStatus(invoiceId: string): Promise<MonobankPaymentStatus> {
    logger.info('[MockMonobankService] Mock status check', { invoiceId });
    return {
      status: 'success',
      amount: 0,
      currency: 'UAH',
      invoiceId,
    };
  }
}
