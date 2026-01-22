/**
 * Subscription Routes
 * Manage subscription plans and user subscriptions
 */

import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler.js';
import { requireAuth } from '../middleware/auth.js';
import * as subscriptionController from '../controllers/subscriptions.js';

const router = Router();

// Public routes (no auth required)
router.get('/plans', asyncHandler(subscriptionController.listPlans));

// Protected routes
router.use(requireAuth as any);

router.get('/current', asyncHandler(subscriptionController.getCurrentSubscription));
router.post('/subscribe', asyncHandler(subscriptionController.subscribe));
router.post('/cancel', asyncHandler(subscriptionController.cancelSubscription));
router.post('/reactivate', asyncHandler(subscriptionController.reactivateSubscription));

export default router;
