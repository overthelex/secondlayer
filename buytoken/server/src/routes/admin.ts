/**
 * Admin Routes
 * User management, subscription management, platform statistics
 */

import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import * as adminController from '../controllers/admin.js';

const router = Router();

// All routes require admin authentication
router.use(requireAuth as any);
router.use(requireAdmin as any);

// User Management
router.get('/users', asyncHandler(adminController.listUsers));
router.get('/users/:userId', asyncHandler(adminController.getUserDetails));
router.patch('/users/:userId', asyncHandler(adminController.updateUser));
router.delete('/users/:userId', asyncHandler(adminController.deleteUser));

// Subscription Management
router.get('/subscriptions', asyncHandler(adminController.listSubscriptions));
router.patch('/subscriptions/:subscriptionId', asyncHandler(adminController.updateSubscription));

// Invoice Management
router.get('/invoices', asyncHandler(adminController.listInvoices));
router.get('/invoices/:invoiceId', asyncHandler(adminController.getInvoiceDetails));

// Token Management
router.post('/tokens/adjust', asyncHandler(adminController.adjustUserTokens));

// Platform Statistics
router.get('/stats', asyncHandler(adminController.getPlatformStats));

// Audit Log
router.get('/audit-log', asyncHandler(adminController.getAuditLog));

export default router;
