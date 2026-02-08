/**
 * Authentication Routes
 * Handles Google OAuth, password auth, registration, email verification, and password reset
 */

import { Router } from 'express';
import passport from 'passport';
import * as authController from '../controllers/auth.js';
import { authRateLimit, passwordResetRateLimit } from '../middleware/rate-limit.js';

const router: Router = Router();

/**
 * @route   POST /auth/login
 * @desc    Login with email and password
 * @access  Public (rate limited)
 */
router.post('/login', authRateLimit as any, authController.loginWithPassword as any);

/**
 * @route   POST /auth/register
 * @desc    Register new user with email and password
 * @access  Public (rate limited)
 */
router.post('/register', authRateLimit as any, authController.registerWithPassword as any);

/**
 * @route   POST /auth/verify-email
 * @desc    Verify email with token
 * @access  Public
 */
router.post('/verify-email', authController.verifyEmail as any);

/**
 * @route   POST /auth/forgot-password
 * @desc    Request password reset email
 * @access  Public (strictly rate limited)
 */
router.post('/forgot-password', passwordResetRateLimit as any, authController.forgotPassword as any);

/**
 * @route   POST /auth/reset-password
 * @desc    Reset password with token
 * @access  Public (rate limited)
 */
router.post('/reset-password', authRateLimit as any, authController.resetPassword as any);

/**
 * @route   GET /auth/google
 * @desc    Initiate Google OAuth flow
 * @access  Public
 */
router.get('/google', authController.googleOAuthInit);

/**
 * @route   GET /auth/google/callback
 * @desc    Google OAuth callback URL
 * @access  Public
 *
 * This is where Google redirects after user authentication.
 * Passport handles the OAuth exchange, then we generate a JWT.
 */
router.get(
  '/google/callback',
  passport.authenticate('google', {
    session: false,
    failureRedirect: process.env.FRONTEND_URL + '/login?error=oauth_failed',
  }),
  (authController.googleOAuthCallback as any)
);

/**
 * @route   GET /auth/me
 * @desc    Get current user profile
 * @access  Protected (JWT required)
 *
 * Note: JWT authentication middleware will be applied in http-server.ts
 */
router.get('/me', (authController.getCurrentUser as any));

/**
 * @route   POST /auth/logout
 * @desc    Logout user
 * @access  Protected (JWT required)
 *
 * With JWT, logout is primarily handled client-side by deleting the token.
 * This endpoint can be used for logging or cleanup.
 */
router.post('/logout', authController.logout as any);

/**
 * @route   POST /auth/refresh
 * @desc    Refresh JWT token
 * @access  Protected (valid JWT required)
 *
 * Takes an existing valid token and issues a new one with fresh expiry.
 */
router.post('/refresh', authController.refreshToken as any);

/**
 * @route   PUT /auth/profile
 * @desc    Update user profile
 * @access  Protected (JWT required)
 *
 * Allows authenticated users to update their profile information (name, picture).
 * Email cannot be changed as it's managed by Google OAuth.
 */
router.put('/profile', authController.updateProfile as any);

export default router;
