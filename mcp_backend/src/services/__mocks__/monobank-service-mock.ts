/**
 * MockMonobankService
 * Dev/test stub that simulates Monobank without real API calls.
 * Stores invoices in-memory for idempotent webhook simulation.
 */

import { logger } from '../../utils/logger.js';
import { MonobankService, MonobankInvoiceResult, MonobankPaymentStatus, MonobankWebhookBody } from '../monobank-service.js';
import { BillingService } from '../billing-service.js';
import { EmailService } from '../email-service.js';
import type { IDatabase } from '../../domain/ports/index.js';

export class MockMonobankService extends MonobankService {
  private mockInvoices: Map<string, any> = new Map();

  constructor(
    billingService: BillingService,
    emailService: EmailService,
    db?: IDatabase
  ) {
    // Pass a no-op db if not provided (for backward compatibility in tests)
    super(billingService, emailService, db || { query: async () => ({ rows: [] }) } as any);
    logger.info('MockMonobankService initialized (TEST MODE)');
  }

  async createInvoice(
    userId: string,
    amountUah: number,
    description: string,
    redirectUrl?: string,
    email?: string
  ): Promise<MonobankInvoiceResult> {
    if (amountUah < 1) {
      throw new Error('Мінімальна сума поповнення — 1 ₴');
    }

    const invoiceId = `mock-mono-${Date.now()}-${userId.substring(0, 8)}`;
    const pageUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payment/success?mock=true&invoiceId=${invoiceId}`;

    this.mockInvoices.set(invoiceId, {
      userId,
      amountUah,
      email,
      status: 'pending',
    });

    logger.info('[MockMonobankService] Created mock invoice', { userId, amountUah, invoiceId });

    return { invoiceId, pageUrl, paymentIntentId: invoiceId };
  }

  async handleWebhook(_rawBody: Buffer | string, body: MonobankWebhookBody, _signature: string): Promise<{ received: boolean }> {
    logger.info('[MockMonobankService] Mock webhook received', { invoiceId: body.invoiceId, status: body.status });

    if (body.status === 'success' && this.mockInvoices.has(body.invoiceId)) {
      const invoice = this.mockInvoices.get(body.invoiceId);
      if (invoice.status !== 'succeeded') {
        invoice.status = 'succeeded';
        this.mockInvoices.set(body.invoiceId, invoice);

        await this.billingService.topUpBalance({
          userId: invoice.userId,
          amountUsd: 0,
          amountUah: invoice.amountUah,
          description: `[MOCK] Поповнення через Monobank: ${invoice.amountUah} ₴`,
          paymentProvider: 'monobank_mock',
          paymentId: body.invoiceId,
          metadata: { invoiceId: body.invoiceId },
        });

        logger.info('[MockMonobankService] Payment succeeded', { invoiceId: body.invoiceId, amountUah: invoice.amountUah });
      }
    }

    return { received: true };
  }

  async getPaymentStatus(invoiceId: string): Promise<MonobankPaymentStatus> {
    const invoice = this.mockInvoices.get(invoiceId);
    if (invoice) {
      return {
        status: invoice.status === 'succeeded' ? 'success' : 'created',
        amount: invoice.amountUah,
        currency: 'UAH',
        invoiceId,
      };
    }

    logger.info('[MockMonobankService] Mock status check', { invoiceId });
    return {
      status: 'success',
      amount: 0,
      currency: 'UAH',
      invoiceId,
    };
  }

  /**
   * Mock-only: simulate a successful payment (for testing)
   */
  async simulatePaymentSuccess(invoiceId: string): Promise<void> {
    const invoice = this.mockInvoices.get(invoiceId);
    if (!invoice) {
      throw new Error('Invoice not found');
    }

    await this.handleWebhook(
      Buffer.from(JSON.stringify({ invoiceId, status: 'success', amount: Math.round(invoice.amountUah * 100), ccy: 980 })),
      { invoiceId, status: 'success', amount: Math.round(invoice.amountUah * 100), ccy: 980 },
      'mock_signature'
    );
  }
}
