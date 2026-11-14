/**
 * Payment Routes
 * Handles payment creation and webhook callbacks
 */

import { Router, Request, Response } from 'express';
import { MonobankService, CARD_VERIFY_AMOUNT_UAH } from '../services/monobank-service.js';
import { WELCOME_BONUS_UAH } from '../config/welcome-bonus.js';
import { normalizeDeviceId } from '../services/welcome-bonus-service.js';
import { callerFromHeaders } from '../services/mcp-access-log.js';
import { MetaMaskService } from '../services/metamask-service.js';
import { BinancePayService } from '../services/binance-pay-service.js';
import { NOWPaymentsService } from '../services/nowpayments-service.js';
import { MockMonobankService } from '../services/__mocks__/monobank-service-mock.js';
import { MockMetaMaskService } from '../services/__mocks__/metamask-service-mock.js';
import { MockBinancePayService } from '../services/__mocks__/binance-pay-service-mock.js';
import { MockNOWPaymentsService } from '../services/__mocks__/nowpayments-service-mock.js';
import { cryptoTagRequired } from '../middleware/crypto-tag-required.js';
import { logger } from '../utils/logger.js';
import type { IDatabase } from '../domain/ports/index.js';
import { ConsultationPaymentService } from '../services/consultation-payment-service.js';

/**
 * Create payment router
 */
export function createPaymentRouter(
  monobankService: MonobankService | MockMonobankService,
  metamaskService: MetaMaskService | MockMetaMaskService,
  binancePayService: BinancePayService | MockBinancePayService,
  nowpaymentsService: NOWPaymentsService | MockNOWPaymentsService,
  db: IDatabase
): Router {
  const router = Router();

  router.get('/available-providers', async (req: any, res: Response) => {
    try {
      const userId = req.user?.userId || req.user?.id;
      const tagResult = await db.query('SELECT 1 FROM user_tags WHERE user_id = $1 AND tag = $2', [userId, 'crypto']);
      const hasCryptoTag = tagResult.rows.length > 0;
      return res.json({
        providers: [
          { id: 'monobank', name: 'Monobank', enabled: true, currency: 'UAH' },
          { id: 'metamask', name: 'MetaMask', enabled: hasCryptoTag, currency: 'Crypto' },
          { id: 'binance_pay', name: 'Binance Pay', enabled: hasCryptoTag, currency: 'USDT' },
          { id: 'nowpayments', name: 'NOWPayments', enabled: true, currency: 'Crypto' },
        ],
      });
    } catch (error: any) {
      logger.error('Failed to get available providers', { error: error.message });
      return res.status(500).json({ error: 'Failed to get available providers' });
    }
  });

  /**
   * @route   POST /api/billing/payment/monobank/create
   * @desc    Create Monobank invoice (hosted payment page)
   * @access  Protected (JWT required)
   */
  router.post('/monobank/create', async (req: any, res: Response) => {
    try {
      const userId = req.user?.userId || req.user?.id;
      const { amount_uah, redirect_url } = req.body;

      if (!amount_uah || typeof amount_uah !== 'number' || amount_uah < 1) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'amount_uah is required and must be a number >= 1',
        });
      }

      const email = req.user?.email;
      const description = `Поповнення балансу SecondLayer: ${amount_uah} ₴`;
      const result = await monobankService.createInvoice(userId, amount_uah, description, redirect_url, email);

      return res.json(result);
    } catch (error: any) {
      logger.error('Failed to create Monobank invoice', { error: error.message });
      return res.status(500).json({
        error: 'Payment creation failed',
        message: 'An unexpected error occurred',
      });
    }
  });

  /**
   * @route   GET /api/billing/payment/welcome-bonus
   * @desc    Whether this account can still get the welcome bonus by verifying a card
   * @access  Protected (JWT required)
   */
  router.get('/welcome-bonus', async (req: any, res: Response) => {
    try {
      const userId = req.user?.userId || req.user?.id;
      const status = await monobankService.welcomeBonus.status(userId);
      return res.json({
        amount_uah: WELCOME_BONUS_UAH,
        verify_amount_uah: CARD_VERIFY_AMOUNT_UAH,
        status,
        available: status === 'available',
      });
    } catch (error: any) {
      logger.error('Failed to get welcome bonus status', { error: error.message });
      return res.status(500).json({ error: 'Failed to get welcome bonus status' });
    }
  });

  /**
   * @route   POST /api/billing/payment/monobank/card-verify
   * @desc    1 UAH invoice that verifies a card; the welcome bonus is credited
   *          by the webhook and the 1 UAH is refunded
   * @access  Protected (JWT required)
   */
  router.post('/monobank/card-verify', async (req: any, res: Response) => {
    try {
      const userId = req.user?.userId || req.user?.id;
      const result = await monobankService.createCardVerifyInvoice(userId, req.user?.email, {
        clientIp: callerFromHeaders(req.headers, req.ip).clientIp,
        deviceId: normalizeDeviceId(req.body?.device_id),
      });
      return res.json(result);
    } catch (error: any) {
      if (error.message === 'WELCOME_BONUS_ALREADY_CLAIMED') {
        return res.status(409).json({ error: 'already_claimed', message: 'Вітальний бонус для цього акаунта вже нараховано.' });
      }
      logger.error('Failed to create card verification invoice', { error: error.message });
      return res.status(500).json({ error: 'Payment creation failed', message: 'An unexpected error occurred' });
    }
  });

  /**
   * @route   GET /api/billing/payment/monobank/:invoiceId/status
   * @desc    Get Monobank invoice status
   * @access  Protected (JWT required)
   */
  router.get('/monobank/:invoiceId/status', async (req: any, res: Response) => {
    try {
      const { invoiceId } = req.params;
      const status = await monobankService.getPaymentStatus(invoiceId);
      return res.json(status);
    } catch (error: any) {
      logger.error('Failed to get Monobank payment status', { error: error.message });
      return res.status(500).json({ error: 'Failed to get payment status', message: error.message });
    }
  });

  router.post('/metamask/create', cryptoTagRequired, async (req: any, res: Response) => {
    try {
      const userId = req.user?.userId || req.user?.id;
      const email = req.user?.email;
      const { amount_usd, network, token } = req.body;
      if (!amount_usd || typeof amount_usd !== 'number') {
        return res.status(400).json({ error: 'Invalid request', message: 'amount_usd is required and must be a number' });
      }
      if (!network || !token) {
        return res.status(400).json({ error: 'Invalid request', message: 'network and token are required' });
      }
      const result = await metamaskService.createPaymentIntent(userId, amount_usd, email, network, token);
      return res.json(result);
    } catch (error: any) {
      logger.error('Failed to create MetaMask payment', { error: error.message });
      return res.status(500).json({ error: 'Payment creation failed', message: error.message });
    }
  });

  router.post('/metamask/verify', async (req: any, res: Response) => {
    try {
      const { paymentIntentId, txHash } = req.body;
      if (!paymentIntentId || !txHash) {
        return res.status(400).json({ error: 'Invalid request', message: 'paymentIntentId and txHash are required' });
      }
      const result = await metamaskService.verifyTransaction(paymentIntentId, txHash);
      return res.json(result);
    } catch (error: any) {
      logger.error('Failed to verify MetaMask transaction', { error: error.message });
      return res.status(500).json({ error: 'Verification failed', message: error.message });
    }
  });

  router.post('/binance-pay/create', cryptoTagRequired, async (req: any, res: Response) => {
    try {
      const userId = req.user?.userId || req.user?.id;
      const email = req.user?.email;
      const { amount_usd } = req.body;
      if (!amount_usd || typeof amount_usd !== 'number') {
        return res.status(400).json({ error: 'Invalid request', message: 'amount_usd is required and must be a number' });
      }
      const result = await binancePayService.createOrder(userId, amount_usd, email);
      return res.json(result);
    } catch (error: any) {
      logger.error('Failed to create Binance Pay order', { error: error.message });
      return res.status(500).json({ error: 'Payment creation failed', message: error.message });
    }
  });

  /**
   * @route   POST /api/billing/payment/nowpayments/create
   * @desc    Create NOWPayments hosted invoice for crypto payment
   * @access  Protected (JWT required)
   */
  router.post('/nowpayments/create', async (req: any, res: Response) => {
    try {
      const userId = req.user?.userId || req.user?.id;
      const email = req.user?.email;
      const { amount_usd } = req.body;
      if (!amount_usd || typeof amount_usd !== 'number' || amount_usd < 1) {
        return res.status(400).json({ error: 'Invalid request', message: 'amount_usd is required and must be a number >= 1' });
      }
      const result = await nowpaymentsService.createInvoice(userId, amount_usd, email);
      return res.json(result);
    } catch (error: any) {
      logger.error('Failed to create NOWPayments invoice', { error: error.message });
      return res.status(500).json({ error: 'Payment creation failed', message: error.message });
    }
  });

  router.get('/:provider/:paymentId/status', async (req: any, res: Response) => {
    try {
      const { provider, paymentId } = req.params;

      let status;
      if (provider === 'metamask') {
        status = await metamaskService.getPaymentStatus(paymentId);
      } else if (provider === 'binance_pay') {
        status = await binancePayService.getPaymentStatus(paymentId);
      } else if (provider === 'nowpayments') {
        status = await nowpaymentsService.getPaymentStatus(paymentId);
      } else {
        return res.status(400).json({
          error: 'Invalid provider',
          message: 'Provider must be metamask, binance_pay, or nowpayments',
        });
      }

      return res.json(status);
    } catch (error: any) {
      logger.error('Failed to get payment status', { error: error.message });
      return res.status(500).json({
        error: 'Failed to get payment status',
        message: 'An unexpected error occurred',
      });
    }
  });

  return router;
}

/**
 * Create webhook router (no JWT, uses signature verification)
 */
export function createWebhookRouter(
  monobankService: MonobankService | MockMonobankService,
  binancePayService: BinancePayService | MockBinancePayService,
  nowpaymentsService: NOWPaymentsService | MockNOWPaymentsService,
  consultationPaymentService?: ConsultationPaymentService
): Router {
  const router = Router();

  /**
   * @route   POST /webhooks/monobank
   * @desc    Monobank webhook endpoint
   * @access  Public (signature verified)
   */
  router.post('/monobank', async (req: Request, res: Response) => {
    try {
      const signature = req.headers['x-sign'] as string;
      if (!signature) {
        return res.status(400).json({ error: 'Missing X-Sign header' });
      }
      // req.body is a Buffer when raw body parser works, or already parsed object
      const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
      const parsed = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString('utf8')) : req.body;
      const result = await monobankService.handleWebhook(rawBody, parsed, signature);

      // Check if this is a consultation payment and handle accordingly
      if (consultationPaymentService && parsed?.invoiceId) {
        try {
          const status = parsed.status || (result as any)?.status;
          await consultationPaymentService.handleWebhook(parsed.invoiceId, status);
        } catch (err: any) {
          logger.debug('Consultation payment webhook handling (non-critical)', { error: err.message });
        }
      }

      return res.json(result);
    } catch (error: any) {
      logger.error('Monobank webhook failed', { error: error.message });
      return res.status(400).json({
        error: 'Webhook processing failed',
        message: 'An unexpected error occurred',
      });
    }
  });

  router.post('/binance-pay', async (req: Request, res: Response) => {
    try {
      const headers: Record<string, string> = {
        'binancepay-timestamp': req.headers['binancepay-timestamp'] as string || '',
        'binancepay-nonce': req.headers['binancepay-nonce'] as string || '',
        'binancepay-signature': req.headers['binancepay-signature'] as string || '',
      };
      const result = await binancePayService.handleWebhook(req.body, headers);
      res.json(result);
    } catch (error: any) {
      logger.error('Binance Pay webhook failed', { error: error.message });
      res.status(400).json({ error: 'Webhook processing failed', message: error.message });
    }
  });

  /**
   * @route   POST /webhooks/nowpayments
   * @desc    NOWPayments IPN webhook endpoint
   * @access  Public (HMAC-SHA512 signature verified)
   */
  router.post('/nowpayments', async (req: Request, res: Response) => {
    try {
      const signature = req.headers['x-nowpayments-sig'] as string;
      if (!signature) {
        return res.status(400).json({ error: 'Missing x-nowpayments-sig header' });
      }
      const rawBody: Buffer = req.body;
      const result = await nowpaymentsService.handleWebhook(rawBody, signature);
      return res.json(result);
    } catch (error: any) {
      logger.error('NOWPayments webhook failed', { error: error.message });
      return res.status(400).json({ error: 'Webhook processing failed', message: error.message });
    }
  });

  return router;
}
