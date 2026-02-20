/**
 * Payment Routes
 * Handles payment creation and webhook callbacks
 */

import { Router, Request, Response } from 'express';
import { MonobankService } from '../services/monobank-service.js';
import { MetaMaskService } from '../services/metamask-service.js';
import { BinancePayService } from '../services/binance-pay-service.js';
import { MockMonobankService } from '../services/__mocks__/monobank-service-mock.js';
import { MockMetaMaskService } from '../services/__mocks__/metamask-service-mock.js';
import { MockBinancePayService } from '../services/__mocks__/binance-pay-service-mock.js';
import { cryptoTagRequired } from '../middleware/crypto-tag-required.js';
import { BaseDatabase } from '@secondlayer/shared';
import { logger } from '../utils/logger.js';

/**
 * Create payment router
 */
export function createPaymentRouter(
  monobankService: MonobankService | MockMonobankService,
  metamaskService: MetaMaskService | MockMetaMaskService,
  binancePayService: BinancePayService | MockBinancePayService,
  db: BaseDatabase
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

      if (!amount_uah || typeof amount_uah !== 'number') {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'amount_uah is required and must be a number',
        });
      }

      const description = `SecondLayer balance top-up: ${amount_uah} UAH`;
      const result = await monobankService.createInvoice(userId, amount_uah, description, redirect_url);

      return res.json(result);
    } catch (error: any) {
      logger.error('Failed to create Monobank invoice', { error: error.message });
      return res.status(500).json({
        error: 'Payment creation failed',
        message: error.message,
      });
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

  router.get('/:provider/:paymentId/status', async (req: any, res: Response) => {
    try {
      const { provider, paymentId } = req.params;

      let status;
      if (provider === 'monobank') {
        status = await monobankService.getPaymentStatus(paymentId);
      } else if (provider === 'metamask') {
        status = await metamaskService.getPaymentStatus(paymentId);
      } else if (provider === 'binance_pay') {
        status = await binancePayService.getPaymentStatus(paymentId);
      } else {
        return res.status(400).json({
          error: 'Invalid provider',
          message: 'Provider must be monobank, metamask, or binance_pay',
        });
      }

      return res.json(status);
    } catch (error: any) {
      logger.error('Failed to get payment status', { error: error.message });
      return res.status(500).json({
        error: 'Failed to get payment status',
        message: error.message,
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
  binancePayService: BinancePayService | MockBinancePayService
): Router {
  const router = Router();

  /**
   * @route   POST /webhooks/monobank
   * @desc    Monobank webhook endpoint
   * @access  Public (signature verified)
   */
  router.post('/monobank', async (req: Request, res: Response) => {
    try {
      const signature = req.headers['x-sign'] as string || '';
      const result = await monobankService.handleWebhook(req.body, signature);
      return res.json(result);
    } catch (error: any) {
      logger.error('Monobank webhook failed', { error: error.message });
      return res.status(400).json({
        error: 'Webhook processing failed',
        message: error.message,
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

  return router;
}
