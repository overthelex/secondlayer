/**
 * Payment Routes
 * Handles payment creation and webhook callbacks
 */

import { Router, Request, Response } from 'express';
import { StripeService } from '../services/stripe-service.js';
import { FondyService } from '../services/fondy-service.js';
import { MetaMaskService } from '../services/metamask-service.js';
import { BinancePayService } from '../services/binance-pay-service.js';
import { MockStripeService } from '../services/__mocks__/stripe-service-mock.js';
import { MockFondyService } from '../services/__mocks__/fondy-service-mock.js';
import { MockMetaMaskService } from '../services/__mocks__/metamask-service-mock.js';
import { MockBinancePayService } from '../services/__mocks__/binance-pay-service-mock.js';
import { cryptoTagRequired } from '../middleware/crypto-tag-required.js';
import { BaseDatabase } from '@secondlayer/shared';
import { logger } from '../utils/logger.js';

/**
 * Create payment router
 */
export function createPaymentRouter(
  stripeService: StripeService | MockStripeService,
  fondyService: FondyService | MockFondyService,
  metamaskService: MetaMaskService | MockMetaMaskService,
  binancePayService: BinancePayService | MockBinancePayService,
  db: BaseDatabase
): Router {
  const router = Router();

  router.get('/available-providers', async (req: any, res: Response) => {
    try {
      const userId = req.user.userId;
      const tagResult = await db.query('SELECT 1 FROM user_tags WHERE user_id = $1 AND tag = $2', [userId, 'crypto']);
      const hasCryptoTag = tagResult.rows.length > 0;
      return res.json({
        providers: [
          { id: 'stripe', name: 'Stripe', enabled: true, currency: 'USD' },
          { id: 'fondy', name: 'Fondy', enabled: true, currency: 'UAH' },
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
   * @route   POST /api/billing/payment/stripe/create
   * @desc    Create Stripe PaymentIntent
   * @access  Protected (JWT required)
   */
  router.post('/stripe/create', async (req: any, res: Response) => {
    try {
      const userId = req.user.userId;
      const email = req.user.email;
      const { amount_usd, metadata } = req.body;

      if (!amount_usd || typeof amount_usd !== 'number') {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'amount_usd is required and must be a number',
        });
      }

      const result = await stripeService.createPaymentIntent(
        userId,
        amount_usd,
        email,
        metadata
      );

      return res.json(result);
    } catch (error: any) {
      logger.error('Failed to create Stripe payment', {
        error: error.message,
      });
      return res.status(500).json({
        error: 'Payment creation failed',
        message: error.message,
      });
    }
  });

  /**
   * @route   POST /api/billing/payment/fondy/create
   * @desc    Create Fondy payment
   * @access  Protected (JWT required)
   */
  router.post('/fondy/create', async (req: any, res: Response) => {
    try {
      const userId = req.user.userId;
      const email = req.user.email;
      const { amount_uah } = req.body;

      if (!amount_uah || typeof amount_uah !== 'number') {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'amount_uah is required and must be a number',
        });
      }

      // Generate unique order ID
      const orderId = `SL-${userId.substring(0, 8)}-${Date.now()}`;
      const description = `SecondLayer balance top-up: ${amount_uah} UAH`;

      const result = await fondyService.createPayment(
        userId,
        amount_uah,
        email,
        orderId,
        description
      );

      return res.json(result);
    } catch (error: any) {
      logger.error('Failed to create Fondy payment', {
        error: error.message,
      });
      return res.status(500).json({
        error: 'Payment creation failed',
        message: error.message,
      });
    }
  });

  router.post('/metamask/create', cryptoTagRequired, async (req: any, res: Response) => {
    try {
      const userId = req.user.userId;
      const email = req.user.email;
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
      const userId = req.user.userId;
      const email = req.user.email;
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
      if (provider === 'stripe') {
        status = await stripeService.getPaymentStatus(paymentId);
      } else if (provider === 'fondy') {
        status = await fondyService.getPaymentStatus(paymentId);
      } else if (provider === 'metamask') {
        status = await metamaskService.getPaymentStatus(paymentId);
      } else if (provider === 'binance_pay') {
        status = await binancePayService.getPaymentStatus(paymentId);
      } else {
        return res.status(400).json({
          error: 'Invalid provider',
          message: 'Provider must be stripe, fondy, metamask, or binance_pay',
        });
      }

      return res.json(status);
    } catch (error: any) {
      logger.error('Failed to get payment status', {
        error: error.message,
      });
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
  stripeService: StripeService | MockStripeService,
  fondyService: FondyService | MockFondyService,
  binancePayService: BinancePayService | MockBinancePayService
): Router {
  const router = Router();

  /**
   * @route   POST /webhooks/stripe
   * @desc    Stripe webhook endpoint
   * @access  Public (signature verified)
   *
   * Note: This endpoint requires raw body for signature verification.
   * Must be mounted BEFORE json() middleware in http-server.ts
   */
  router.post(
    '/stripe',
    async (req: Request, res: Response) => {
      try {
        const signature = req.headers['stripe-signature'] as string;

        if (!signature) {
          logger.warn('Stripe webhook missing signature');
          return res.status(400).json({ error: 'Missing signature' });
        }

        // req.body should be raw buffer here
        const result = await stripeService.handleWebhook(
          req.body,
          signature
        );

        return res.json(result);
      } catch (error: any) {
        logger.error('Stripe webhook failed', {
          error: error.message,
        });
        return res.status(400).json({
          error: 'Webhook processing failed',
          message: error.message,
        });
      }
    }
  );

  /**
   * @route   POST /webhooks/fondy
   * @desc    Fondy server callback endpoint
   * @access  Public (signature verified)
   */
  router.post('/fondy', async (req: Request, res: Response) => {
    try {
      await fondyService.handleCallback(req.body);
      res.json({ received: true });
    } catch (error: any) {
      logger.error('Fondy callback failed', {
        error: error.message,
      });
      res.status(400).json({
        error: 'Callback processing failed',
        message: error.message,
      });
    }
  });

  /**
   * @route   POST /webhooks/fondy/subscription
   * @desc    Fondy subscription callback endpoint
   * @access  Public (signature verified)
   */
  router.post('/fondy/subscription', async (req: Request, res: Response) => {
    try {
      await fondyService.handleSubscriptionCallback(req.body);
      res.json({ received: true });
    } catch (error: any) {
      logger.error('Fondy subscription callback failed', {
        error: error.message,
      });
      res.status(400).json({
        error: 'Subscription callback processing failed',
        message: error.message,
      });
    }
  });

  /**
   * @route   POST /webhooks/fondy/chargeback
   * @desc    Fondy chargeback callback endpoint
   * @access  Public (signature verified)
   */
  router.post('/fondy/chargeback', async (req: Request, res: Response) => {
    try {
      await fondyService.handleChargebackCallback(req.body);
      res.json({ received: true });
    } catch (error: any) {
      logger.error('Fondy chargeback callback failed', {
        error: error.message,
      });
      res.status(400).json({
        error: 'Chargeback callback processing failed',
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
