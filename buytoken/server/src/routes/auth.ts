/**
 * Authentication Routes
 * Handles user registration, login, OAuth, password reset
 */

import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler.js';
import passport from '../config/passport.js';
import * as authController from '../controllers/auth.js';

const router = Router();

// Email/Password Authentication
router.post('/register', asyncHandler(authController.register));
router.post('/login', asyncHandler(authController.login));
router.post('/logout', asyncHandler(authController.logout));

// Google OAuth2
router.get('/google', authController.googleOAuthInit);
router.get('/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/index.html?error=oauth_failed' }),
  asyncHandler(authController.googleOAuthCallback)
);

// Token Management
router.post('/refresh', asyncHandler(authController.refreshToken));

// Password Management
router.post('/forgot-password', asyncHandler(authController.forgotPassword));
router.post('/reset-password', asyncHandler(authController.resetPassword));

// Email Verification
router.get('/verify-email', asyncHandler(authController.verifyEmail));

export default router;
