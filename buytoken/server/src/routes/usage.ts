/**
 * Usage Routes
 * Token balance, usage history, statistics
 */

import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler.js';
import { requireAuth } from '../middleware/auth.js';
import * as usageController from '../controllers/usage.js';

const router = Router();

// All routes require authentication
router.use(requireAuth as any);

router.get('/balance', asyncHandler(usageController.getBalance));
router.get('/history', asyncHandler(usageController.getTransactionHistory));
router.get('/stats', asyncHandler(usageController.getUsageStats));
router.get('/breakdown', asyncHandler(usageController.getUsageBreakdown));

export default router;
