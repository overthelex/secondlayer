/**
 * Payment Routes
 * Payment methods, token purchases, webhooks
 */

import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler.js';
import { requireAuth } from '../middleware/auth.js';
import * as paymentController from '../controllers/payments.js';

const router = Router();

// Protected routes
router.use(requireAuth as any);

// Payment Methods
router.get('/methods', asyncHandler(paymentController.listPaymentMethods));
router.post('/methods', asyncHandler(paymentController.addPaymentMethod));
router.delete('/methods/:methodId', asyncHandler(paymentController.removePaymentMethod));
router.post('/methods/:methodId/set-default', asyncHandler(paymentController.setDefaultPaymentMethod));

// Token Purchases
router.post('/buy-tokens', asyncHandler(paymentController.buyTokens));

// Payment Provider Specific
router.post('/monobank/qr', asyncHandler(paymentController.generateMonobankQR));
router.post('/crypto/prepare', asyncHandler(paymentController.prepareCryptoPayment));

// Webhooks (no auth, verified by signature)
router.post('/webhooks/stripe', asyncHandler(paymentController.stripeWebhook));
router.post('/webhooks/monobank', asyncHandler(paymentController.monobankWebhook));

export default router;
