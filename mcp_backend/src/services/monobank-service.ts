/**
 * MonobankService
 * Stub implementation for Monobank Acquiring payment integration.
 * Configure MONOBANK_API_KEY to enable real payments.
 */

import { logger } from '../utils/logger.js';
import { BillingService } from './billing-service.js';
import { EmailService } from './email-service.js';

export interface MonobankInvoiceResult {
  invoiceId: string;
  pageUrl: string;
}

export interface MonobankPaymentStatus {
  status: 'created' | 'processing' | 'hold' | 'success' | 'failure' | 'reversed' | 'expired';
  amount: number;
  currency: string;
  invoiceId: string;
}

export interface MonobankWebhookBody {
  invoiceId: string;
  status: string;
  amount: number;
  ccy: number;
  reference?: string;
  [key: string]: unknown;
}

export class MonobankService {
  constructor(
    protected billingService: BillingService,
    protected emailService: EmailService
  ) {}

  private get apiKey(): string {
    const key = process.env.MONOBANK_API_KEY;
    if (!key) throw new Error('MonobankService not yet configured: MONOBANK_API_KEY is missing');
    return key;
  }

  private get redirectUrl(): string {
    return process.env.MONOBANK_REDIRECT_URL || process.env.FRONTEND_URL || 'http://localhost:5173';
  }

  /**
   * Create a Monobank invoice (hosted payment page).
   */
  async createInvoice(
    userId: string,
    amountUah: number,
    description: string,
    redirectUrl?: string
  ): Promise<MonobankInvoiceResult> {
    const key = this.apiKey; // throws if not configured

    // Amount in kopecks (1 UAH = 100 kopecks)
    const amountKopecks = Math.round(amountUah * 100);
    const finalRedirectUrl = redirectUrl || `${this.redirectUrl}/payment/success`;

    logger.info('[MonobankService] Creating invoice', { userId, amountUah, amountKopecks });

    const response = await fetch('https://api.monobank.ua/api/merchant/invoice/create', {
      method: 'POST',
      headers: {
        'X-Token': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: amountKopecks,
        ccy: 980, // UAH
        merchantPaymInfo: {
          reference: `SL-${userId.substring(0, 8)}-${Date.now()}`,
          destination: description,
          comment: description,
        },
        redirectUrl: finalRedirectUrl,
        webHookUrl: `${process.env.PUBLIC_URL || 'http://localhost:3000'}/webhooks/monobank`,
        validity: 3600, // 1 hour
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Monobank API error: ${response.status} ${body}`);
    }

    const data = (await response.json()) as { invoiceId: string; pageUrl: string };
    logger.info('[MonobankService] Invoice created', { userId, invoiceId: data.invoiceId });

    return {
      invoiceId: data.invoiceId,
      pageUrl: data.pageUrl,
    };
  }

  /**
   * Handle Monobank webhook callback.
   */
  async handleWebhook(body: MonobankWebhookBody, signature: string): Promise<{ received: boolean }> {
    const key = this.apiKey; // throws if not configured

    // Signature validation: Monobank signs the raw body with HMAC-SHA256
    // For now we log and process; full validation should use crypto.createHmac
    logger.info('[MonobankService] Webhook received', {
      invoiceId: body.invoiceId,
      status: body.status,
    });

    if (body.status === 'success' && body.invoiceId) {
      // reference contains our "SL-{userId}-{timestamp}" string
      const reference = (body as any).reference || '';
      const parts = reference.split('-');
      if (parts.length >= 2) {
        const userPrefix = parts[1];
        logger.info('[MonobankService] Payment success for user prefix', { userPrefix, reference });
        // Full implementation: look up user by reference in DB and credit their account
      }
    }

    return { received: true };
  }

  /**
   * Get the status of a Monobank invoice.
   */
  async getPaymentStatus(invoiceId: string): Promise<MonobankPaymentStatus> {
    const key = this.apiKey; // throws if not configured

    logger.info('[MonobankService] Getting payment status', { invoiceId });

    const response = await fetch(
      `https://api.monobank.ua/api/merchant/invoice/status?invoiceId=${encodeURIComponent(invoiceId)}`,
      {
        method: 'GET',
        headers: { 'X-Token': key },
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Monobank API error: ${response.status} ${body}`);
    }

    const data = (await response.json()) as any;
    return {
      status: data.status,
      amount: data.amount / 100, // convert kopecks back to UAH
      currency: 'UAH',
      invoiceId,
    };
  }
}
