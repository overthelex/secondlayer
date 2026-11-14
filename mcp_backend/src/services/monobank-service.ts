/**
 * MonobankService
 * Full Monobank Acquiring payment integration.
 * Configure MONOBANK_API_KEY to enable real payments.
 */

import { createVerify, createPublicKey, verify as cryptoVerify } from 'crypto';
import { logger } from '../utils/logger.js';
import { BillingService } from './billing-service.js';
import { EmailService } from './email-service.js';
import { CurrencyService } from './currency-service.js';
import { invoiceService } from './invoice-service.js';
import type { IDatabase } from '../domain/ports/index.js';
import type { AuditService } from './audit-service.js';
import { WELCOME_BONUS_UAH } from '../config/welcome-bonus.js';

/** Amount charged to verify a card; refunded right after the bonus is credited. */
export const CARD_VERIFY_AMOUNT_UAH = 1;

export type CardVerifyOutcome = 'credited' | 'already_claimed' | 'card_used' | 'no_card' | 'failed';

export interface MonobankInvoiceResult {
  invoiceId: string;
  pageUrl: string;
  paymentIntentId: string;
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
  protected auditService?: AuditService;

  constructor(
    protected billingService: BillingService,
    protected emailService: EmailService,
    protected db: IDatabase,
    protected currencyService?: CurrencyService
  ) {}

  setAuditService(auditService: AuditService): void {
    this.auditService = auditService;
  }

  private get apiKey(): string {
    const key = process.env.MONOBANK_API_KEY;
    if (!key) throw new Error('MonobankService not yet configured: MONOBANK_API_KEY is missing');
    return key;
  }

  private getPublicUrl(): string {
    const url = process.env.PUBLIC_URL;
    if (!url) {
      logger.error('PUBLIC_URL is not set — Monobank webhooks will not be delivered');
      throw new Error('PUBLIC_URL environment variable is required for payment webhooks');
    }
    return url;
  }

  private get redirectUrl(): string {
    return process.env.MONOBANK_REDIRECT_URL || process.env.FRONTEND_URL || 'http://localhost:5173';
  }

  /**
   * Create a Monobank invoice (hosted payment page).
   * Stores payment_intent in DB for idempotent webhook processing.
   */
  async createInvoice(
    userId: string,
    amountUah: number,
    description: string,
    redirectUrl?: string,
    email?: string,
    extraMeta: Record<string, unknown> = {}
  ): Promise<MonobankInvoiceResult> {
    const key = this.apiKey; // throws if not configured

    if (amountUah < 1) {
      throw new Error('Мінімальна сума поповнення — 1 ₴');
    }

    // Amount in kopecks (1 UAH = 100 kopecks)
    const amountKopecks = Math.round(amountUah * 100);
    const defaultRedirect = `${this.redirectUrl}/payment/success`;
    let finalRedirectUrl = defaultRedirect;
    if (redirectUrl) {
      try {
        const parsed = new URL(redirectUrl);
        const ALLOWED_REDIRECT_HOSTS = new Set(['legal.org.ua', 'platform.legal.org.ua']);
        if (ALLOWED_REDIRECT_HOSTS.has(parsed.hostname)) {
          finalRedirectUrl = redirectUrl;
        } else {
          logger.warn('[MonobankService] Blocked redirect_url with disallowed host', { host: parsed.hostname });
        }
      } catch {
        logger.warn('[MonobankService] Invalid redirect_url, using default');
      }
    }
    const orderRef = `SL-${userId.substring(0, 8)}-${Date.now()}`;

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
          reference: orderRef,
          destination: description,
          comment: description,
        },
        redirectUrl: finalRedirectUrl,
        webHookUrl: `${this.getPublicUrl()}/webhooks/monobank`,
        validity: 3600, // 1 hour
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Monobank API error: ${response.status} ${body}`);
    }

    const data = (await response.json()) as { invoiceId: string; pageUrl: string };

    // Store payment_intent for idempotent webhook processing
    const insertResult = await this.db.query(
      `INSERT INTO payment_intents
        (user_id, provider, external_id, amount_usd, amount_uah, status, metadata)
       VALUES ($1, 'monobank', $2, $3, $4, 'pending', $5)
       RETURNING id`,
      [
        userId,
        data.invoiceId,
        0, // amount_usd not applicable for UAH payments
        amountUah,
        JSON.stringify({ ...extraMeta, email, orderRef, pageUrl: data.pageUrl }),
      ]
    );

    const paymentIntentId = insertResult.rows[0].id;

    logger.info('[MonobankService] Invoice created', {
      userId,
      invoiceId: data.invoiceId,
      paymentIntentId,
      amountUah,
    });

    return {
      invoiceId: data.invoiceId,
      pageUrl: data.pageUrl,
      paymentIntentId,
    };
  }

  private cachedPubKey: string | null = null;
  private pubKeyFetchedAt = 0;

  /**
   * Fetch Monobank's ECDSA public key for webhook signature verification.
   * Cached for 1 hour.
   */
  private async getMonobankPublicKey(): Promise<string> {
    const ONE_HOUR = 60 * 60 * 1000;
    if (this.cachedPubKey && Date.now() - this.pubKeyFetchedAt < ONE_HOUR) {
      return this.cachedPubKey;
    }

    const response = await fetch('https://api.monobank.ua/api/merchant/pubkey', {
      headers: { 'X-Token': this.apiKey },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Monobank public key: ${response.status}`);
    }

    const data = (await response.json()) as { key: string };
    this.cachedPubKey = data.key;
    this.pubKeyFetchedAt = Date.now();

    logger.info('[MonobankService] Public key fetched/refreshed');
    return data.key;
  }

  /**
   * Validate Monobank webhook ECDSA signature.
   * Monobank signs the raw request body with ECDSA P-256 and sends
   * the base64-encoded signature in the X-Sign header.
   */
  async validateSignature(rawBody: Buffer | string, signature: string): Promise<boolean> {
    try {
      const pubKeyBase64 = await this.getMonobankPublicKey();
      const pubKeyPem = Buffer.from(pubKeyBase64, 'base64').toString('utf8');
      const pubKey = createPublicKey(pubKeyPem);
      const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody;
      const sigBuf = Buffer.from(signature, 'base64');

      // Try DER-encoded signature first (standard Node.js ECDSA format)
      try {
        const verify = createVerify('SHA256');
        verify.update(bodyBuf);
        verify.end();
        if (verify.verify(pubKey, sigBuf)) return true;
      } catch { /* DER parse failed, try P1363 below */ }

      // Fallback: try crypto.verify with IEEE P1363 format (raw r||s, 64 bytes for P-256)
      const valid = cryptoVerify(
        'SHA256',
        bodyBuf,
        { key: pubKey, dsaEncoding: 'ieee-p1363' },
        sigBuf
      );
      if (valid) {
        logger.info('[MonobankService] Signature valid (P1363 format)');
      }
      return valid;
    } catch (err: any) {
      logger.error('[MonobankService] Signature validation error', { error: err.message });
      return false;
    }
  }

  /**
   * Handle Monobank webhook callback.
   * Validates signature, looks up payment_intent, credits balance, sends email.
   */
  async handleWebhook(rawBody: Buffer | string, body: MonobankWebhookBody, signature: string): Promise<{ received: boolean }> {
    if (!(await this.validateSignature(rawBody, signature))) {
      logger.warn('[MonobankService] Webhook signature validation failed');
      throw new Error('Invalid webhook signature');
    }

    logger.info('[MonobankService] Webhook received', {
      invoiceId: body.invoiceId,
      status: body.status,
    });

    // Only process successful payments
    if (body.status !== 'success') {
      // Update status for non-success terminal statuses
      if (['failure', 'reversed', 'expired'].includes(body.status)) {
        await this.db.query(
          'UPDATE payment_intents SET status = $1, updated_at = NOW() WHERE external_id = $2 AND provider = $3',
          [body.status === 'failure' ? 'failed' : body.status, body.invoiceId, 'monobank']
        );
      }
      return { received: true };
    }

    // Look up payment_intent by invoiceId (external_id)
    const piResult = await this.db.query(
      'SELECT * FROM payment_intents WHERE external_id = $1 AND provider = $2',
      [body.invoiceId, 'monobank']
    );

    if (piResult.rows.length === 0) {
      logger.warn('[MonobankService] Webhook: payment intent not found', { invoiceId: body.invoiceId });
      return { received: true };
    }

    const pi = piResult.rows[0];

    // Idempotency: skip if already processed
    if (pi.status === 'succeeded') {
      logger.warn('[MonobankService] Webhook: already processed', { invoiceId: body.invoiceId });
      return { received: true };
    }

    // Mark as succeeded
    await this.db.query(
      'UPDATE payment_intents SET status = $1, updated_at = NOW() WHERE id = $2',
      ['succeeded', pi.id]
    );

    // Verify amount matches stored invoice
    const storedAmountUah = parseFloat(pi.amount_uah);
    const webhookAmountUah = body.amount / 100;
    if (storedAmountUah > 0 && Math.abs(storedAmountUah - webhookAmountUah) > 0.01) {
      logger.error('[MonobankService] Amount mismatch in webhook', {
        stored: storedAmountUah, webhook: webhookAmountUah, invoiceId: body.invoiceId,
      });
      await this.db.query(
        "UPDATE payment_intents SET metadata = metadata || $1::jsonb WHERE id = $2",
        [JSON.stringify({ amount_mismatch: true, webhook_amount: webhookAmountUah }), pi.id]
      );
    }
    if (this.isCardVerify(pi)) {
      await this.processCardVerification(pi, body.invoiceId);
      return { received: true };
    }

    const amountUah = storedAmountUah > 0 ? storedAmountUah : webhookAmountUah;
    let amountUsd = 0;
    if (this.currencyService) {
      try {
        const { amountUsd: converted } = await this.currencyService.convertUahToUsd(amountUah);
        amountUsd = converted;
      } catch (err: any) {
        logger.warn('[MonobankService] Failed to convert UAH to USD, crediting UAH only', { amountUah, error: err.message });
      }
    }
    const transaction = await this.billingService.topUpBalance({
      userId: pi.user_id,
      amountUsd,
      amountUah,
      description: `Поповнення через Monobank: ${amountUah} ₴`,
      paymentProvider: 'monobank',
      paymentId: pi.id,
      metadata: { invoiceId: body.invoiceId, reference: body.reference },
    });

    // Generate invoice number
    const invoiceNumber = invoiceService.generateInvoiceNumber(transaction.id);
    await this.billingService.setTransactionInvoiceNumber(transaction.id, invoiceNumber);

    logger.info('[MonobankService] Payment succeeded', {
      paymentIntentId: pi.id,
      amountUah,
      transactionId: transaction.id,
      invoiceNumber,
    });

    // Audit: payment.received
    if (this.auditService) {
      try {
        await this.auditService.log({
          userId: pi.user_id,
          action: 'payment.received',
          resourceType: 'payment_intent',
          resourceId: pi.id,
          details: { invoiceId: body.invoiceId, amountUah, amountUsd, transactionId: transaction.id },
        });
      } catch (err: any) {
        logger.warn('[Audit] Failed to log payment.received', { error: err.message });
      }
    }

    // Save card details from invoice status (non-blocking)
    try {
      await this.saveCard(pi.user_id, await this.getInvoiceStatusRaw(body.invoiceId));
    } catch (cardErr: any) {
      logger.warn('[MonobankService] Failed to save card (non-critical)', { error: cardErr.message });
    }

    // Send confirmation email
    const metadata = typeof pi.metadata === 'string' ? JSON.parse(pi.metadata) : (pi.metadata || {});
    if (metadata.email) {
      try {
        await this.emailService.sendPaymentSuccess({
          email: metadata.email,
          name: 'User',
          amount: amountUah,
          currency: 'UAH',
          newBalance: transaction.balance_after_usd,
          paymentId: pi.id,
          userId: pi.user_id,
        });
      } catch (emailErr: any) {
        logger.error('[MonobankService] Failed to send confirmation email', { error: emailErr.message });
      }
    }

    return { received: true };
  }

  /**
   * Start card verification for the welcome bonus: a 1 UAH invoice that is
   * refunded once the webhook confirms it. Throws if the account already
   * received the bonus.
   */
  async createCardVerifyInvoice(userId: string, email?: string): Promise<MonobankInvoiceResult> {
    if (await this.hasWelcomeClaim(userId)) {
      throw new Error('WELCOME_BONUS_ALREADY_CLAIMED');
    }
    return this.createInvoice(
      userId,
      CARD_VERIFY_AMOUNT_UAH,
      `Перевірка картки LEX: ${CARD_VERIFY_AMOUNT_UAH} ₴ буде повернено`,
      `${this.redirectUrl}/billing/overview?card_verify=1`,
      email,
      { purpose: 'card_verify' }
    );
  }

  async hasWelcomeClaim(userId: string): Promise<boolean> {
    const r = await this.db.query('SELECT 1 FROM welcome_bonus_claims WHERE user_id = $1', [userId]);
    return r.rows.length > 0;
  }

  private isCardVerify(pi: any): boolean {
    const meta = typeof pi.metadata === 'string' ? JSON.parse(pi.metadata) : (pi.metadata || {});
    return meta.purpose === 'card_verify';
  }

  private async saveCard(userId: string, statusData: any): Promise<string | null> {
    const info = statusData?.paymentInfo;
    if (!info?.maskedPan) return null;
    const last4 = String(info.maskedPan).replace(/[*\s]/g, '').slice(-4);
    await this.billingService.savePaymentMethod(userId, {
      provider: 'monobank',
      cardLast4: last4,
      cardBrand: info.paymentSystem || null,
      cardBank: info.bank || null,
      label: `${(info.paymentSystem || '').toUpperCase()} •••• ${last4}`,
    });
    logger.info('[MonobankService] Card saved from payment', { last4, brand: info.paymentSystem });
    return String(info.maskedPan);
  }

  /**
   * A card-verification invoice was paid: save the card, credit the welcome
   * bonus if neither the account nor the card has claimed it, then refund
   * the 1 UAH. The verification payment itself never reaches the balance.
   */
  async processCardVerification(pi: any, invoiceId: string, statusData?: any): Promise<CardVerifyOutcome> {
    let outcome: CardVerifyOutcome = 'no_card';
    try {
      const maskedPan = await this.saveCard(pi.user_id, statusData ?? await this.getInvoiceStatusRaw(invoiceId));
      if (maskedPan) {
        outcome = await this.claimWelcomeBonus(pi.user_id, maskedPan, invoiceId);
      }
    } catch (err: any) {
      outcome = 'failed';
      logger.error('[CardVerify] Failed to process verification', { userId: pi.user_id, invoiceId, error: err.message });
    }

    await this.db.query(
      'UPDATE payment_intents SET metadata = metadata || $1::jsonb WHERE id = $2',
      [JSON.stringify({ card_verify_outcome: outcome }), pi.id]
    ).catch(() => {});

    try {
      await this.cancelInvoice(invoiceId);
    } catch (err: any) {
      logger.error('[CardVerify] Refund of verification payment failed, refund manually', { invoiceId, error: err.message });
    }

    logger.info('[CardVerify] Done', { userId: pi.user_id, invoiceId, outcome });
    return outcome;
  }

  private async claimWelcomeBonus(userId: string, maskedPan: string, invoiceId: string): Promise<CardVerifyOutcome> {
    // Both user_id and card_masked_pan are unique: one bonus per account and per card.
    const claim = await this.db.query(
      `INSERT INTO welcome_bonus_claims (user_id, card_masked_pan, invoice_id, amount_uah)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING user_id`,
      [userId, maskedPan, invoiceId, WELCOME_BONUS_UAH]
    );
    if (claim.rows.length === 0) {
      return (await this.hasWelcomeClaim(userId)) ? 'already_claimed' : 'card_used';
    }
    try {
      await this.billingService.getOrCreateUserBilling(userId);
      const amountUsd = await this.billingService.convertFromUah(WELCOME_BONUS_UAH);
      await this.billingService.topUpBalance({
        userId,
        amountUsd,
        amountUah: WELCOME_BONUS_UAH,
        description: `Вітальний бонус за прив'язку картки: ${WELCOME_BONUS_UAH} грн`,
        paymentProvider: 'adjustment',
        paymentId: `welcome-${userId}`,
        metadata: { invoiceId },
      });
    } catch (err) {
      // Free the claim so a retry can succeed.
      await this.db.query('DELETE FROM welcome_bonus_claims WHERE user_id = $1', [userId]).catch(() => {});
      throw err;
    }
    logger.info('[WelcomeBonus] Credited after card verification', { userId, amountUah: WELCOME_BONUS_UAH });
    return 'credited';
  }

  /**
   * Get raw invoice status from Monobank (includes paymentInfo with card data).
   */
  private async getInvoiceStatusRaw(invoiceId: string): Promise<any> {
    const key = this.apiKey;
    const response = await fetch(
      `https://api.monobank.ua/api/merchant/invoice/status?invoiceId=${encodeURIComponent(invoiceId)}`,
      { method: 'GET', headers: { 'X-Token': key } }
    );
    if (!response.ok) return null;
    return response.json();
  }

  /**
   * Reconcile pending payment intents older than 1 hour.
   * Checks their real status via Monobank API and processes accordingly.
   */
  async reconcilePendingPayments(): Promise<{ checked: number; resolved: number }> {
    const result = await this.db.query(
      `SELECT * FROM payment_intents
       WHERE provider = 'monobank'
         AND status = 'pending'
         AND created_at < NOW() - INTERVAL '1 hour'
       ORDER BY created_at ASC
       LIMIT 50`
    );

    let resolved = 0;

    for (const pi of result.rows) {
      try {
        const statusData = await this.getInvoiceStatusRaw(pi.external_id);
        if (!statusData) {
          logger.warn('[Reconciliation] Could not fetch invoice status', { invoiceId: pi.external_id });
          continue;
        }

        const monoStatus = statusData.status as string;

        if (monoStatus === 'success') {
          // Webhook was missed — credit balance directly
          logger.info('[Reconciliation] Found missed successful payment, crediting', {
            paymentIntentId: pi.id,
            invoiceId: pi.external_id,
          });

          const marked = await this.db.query(
            `UPDATE payment_intents SET status = 'succeeded', updated_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING id`,
            [pi.id]
          );
          if (this.isCardVerify(pi)) {
            if (marked.rows.length) await this.processCardVerification(pi, pi.external_id, statusData);
            resolved++;
            continue;
          }

          const amountUah = parseFloat(pi.amount_uah) || (statusData.amount / 100);
          let amountUsd = 0;
          if (this.currencyService) {
            try {
              const { amountUsd: converted } = await this.currencyService.convertUahToUsd(amountUah);
              amountUsd = converted;
            } catch { /* fallback to 0 */ }
          }

          await this.billingService.getOrCreateUserBilling(pi.user_id);
          await this.billingService.topUpBalance({
            userId: pi.user_id,
            amountUsd,
            amountUah,
            description: `Поповнення через Monobank (reconciliation): ${amountUah} ₴`,
            paymentProvider: 'monobank',
            paymentId: pi.id,
            metadata: { invoiceId: pi.external_id, reconciled: true },
          });

          if (this.auditService) {
            this.auditService.log({
              userId: pi.user_id,
              action: 'payment.reconciled',
              resourceType: 'payment_intent',
              resourceId: pi.id,
              details: { invoiceId: pi.external_id, amountUah, amountUsd },
            }).catch(() => {});
          }

          resolved++;
        } else if (['failure', 'reversed', 'expired'].includes(monoStatus)) {
          // Terminal state — mark accordingly
          await this.db.query(
            `UPDATE payment_intents SET status = $1, updated_at = NOW() WHERE id = $2`,
            [monoStatus === 'failure' ? 'failed' : monoStatus, pi.id]
          );
          logger.info('[Reconciliation] Marked stale payment as terminal', {
            paymentIntentId: pi.id,
            status: monoStatus,
          });
          resolved++;
        }
        // 'created', 'processing', 'hold' — still in progress, skip
      } catch (err: any) {
        logger.error('[Reconciliation] Error checking payment', {
          paymentIntentId: pi.id,
          error: err.message,
        });
      }
    }

    if (result.rows.length > 0) {
      logger.info('[Reconciliation] Completed', { checked: result.rows.length, resolved });
    }

    return { checked: result.rows.length, resolved };
  }

  /**
   * Cancel (reverse) a held Monobank invoice, releasing the hold on the client's card.
   */
  async cancelInvoice(invoiceId: string): Promise<void> {
    const key = this.apiKey;

    logger.info('[MonobankService] Cancelling invoice (reversing hold)', { invoiceId });

    const response = await fetch(
      'https://api.monobank.ua/api/merchant/invoice/cancel',
      {
        method: 'POST',
        headers: {
          'X-Token': key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ invoiceId }),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Monobank cancel API error: ${response.status} ${body}`);
    }

    logger.info('[MonobankService] Invoice cancelled successfully', { invoiceId });
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
