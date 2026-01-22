/**
 * User Routes
 * User profile, API key management
 */

import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler.js';
import { requireAuth } from '../middleware/auth.js';
import * as userController from '../controllers/users.js';

const router = Router();

// All routes require authentication
router.use(requireAuth as any);

// User Profile
router.get('/profile', asyncHandler(userController.getProfile));
router.patch('/profile', asyncHandler(userController.updateProfile));

// API Key Management
router.get('/api-keys', asyncHandler(userController.listAPIKeys));
router.post('/api-keys', asyncHandler(userController.createAPIKey));
router.delete('/api-keys/:keyId', asyncHandler(userController.revokeAPIKey));

export default router;
