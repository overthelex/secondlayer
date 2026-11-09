/**
 * Auth Password — Password login, registration, email verification, forgot/reset password
 */

import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { logger } from '../utils/logger.js';
import { maskEmail } from '../utils/sanitize-log.js';
import { getUserService } from '../middleware/dual-auth.js';
import { provisionAuthentikUser } from '../services/authentik-service.js';
import { provisionNextcloudUser } from '../services/nextcloud-provisioning.js';
import { requireTurnstile } from '../services/turnstile-service.js';
import {
  generateToken,
  generateBannerAsync,
  creditWelcomeBonus,
  validatePassword,
  validateEmail,
  getAuthEmailService,
  getAuthReferralService,
  JWT_EXPIRES_IN,
} from './auth-common.js';

/**
 * Login with email and password
 * Public route - no authentication required
 */
export async function loginWithPassword(req: Request, res: Response): Promise<Response> {
  try {
    const { email, password } = req.body;

    // Validate inputs
    if (!email || !password) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Email and password are required',
      });
    }

    // Bot check (Cloudflare Turnstile); no-op when TURNSTILE_SECRET_KEY is unset or for the mobile app
    const turnstile = await requireTurnstile(req);
    if (turnstile) {
      return res.status(turnstile.status).json(turnstile.body);
    }

    // Get user service
    const userService = getUserService();

    // Check if account is locked
    const isLocked = await userService.isAccountLocked(email);
    if (isLocked) {
      return res.status(429).json({
        error: 'Too Many Requests',
        message: 'Account is temporarily locked due to too many failed login attempts. Please try again in 15 minutes.',
      });
    }

    // Find user by email
    const user = await userService.findByEmail(email);

    if (!user) {
      // Don't reveal if user exists or not
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid email or password',
      });
    }

    // Check if user has password set
    if (!user.password_hash) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Password authentication not enabled for this account. Please use Google OAuth.',
      });
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordValid) {
      await userService.recordFailedLogin(email);
      logger.warn('Failed login attempt', { email: maskEmail(email) });
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid email or password',
      });
    }

    // Reset failed attempts on successful login
    await userService.resetFailedAttempts(user.id);

    // Update last login
    await userService.updateLastLogin(user.id);

    // Cloudflare leaked-credentials detection: a transform rule on the zone sets
    // "Exposed-Credential-Check: 1" when this email+password pair is in a known breach
    // (and strips the header otherwise, so clients cannot forge it). The login still
    // succeeds; we record it, warn the user by mail (at most weekly) and flag the response.
    const passwordLeaked = req.headers['exposed-credential-check'] === '1';
    if (passwordLeaked) {
      logger.warn('Login with a password found in known breaches', {
        userId: user.id,
        email: maskEmail(user.email),
      });
      const shouldNotify = await userService.markPasswordLeaked(user.id);
      const authEmailService = getAuthEmailService();
      if (shouldNotify && authEmailService) {
        authEmailService.sendLeakedPasswordWarning(user.email).catch(() => {});
      }
    }

    // Generate JWT token
    const token = generateToken(user);

    logger.info('User logged in with password', {
      userId: user.id,
      email: user.email,
    });

    // Return token and user data
    return res.json({
      token,
      expiresIn: JWT_EXPIRES_IN,
      passwordLeaked,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        banner: user.banner || null,
        emailVerified: user.email_verified,
        lastLogin: user.last_login,
        createdAt: user.created_at,
        role: user.role,
      },
    });
  } catch (error: any) {
    logger.error('Error during password login:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'An error occurred during login',
    });
  }
}

/**
 * Register new user with email and password
 * Public route
 */
export async function registerWithPassword(req: Request, res: Response): Promise<Response> {
  try {
    const { email, password, name, referralCode } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Email and password are required',
      });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid email format',
      });
    }

    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({
        error: 'Bad Request',
        message: passwordValidation.message,
      });
    }

    // Bot check (Cloudflare Turnstile); no-op when TURNSTILE_SECRET_KEY is unset or for the mobile app
    const turnstile = await requireTurnstile(req);
    if (turnstile) {
      return res.status(turnstile.status).json(turnstile.body);
    }

    const userService = getUserService();

    // Check if user already exists
    const existingUser = await userService.findByEmail(email);
    if (existingUser) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'User with this email already exists',
      });
    }

    // Create user
    const user = await userService.createUserWithPassword({ email, password, name });

    // Generate banner (fire and forget)
    generateBannerAsync(user.id, user.name || user.email);

    // Provision user in Authentik and Nextcloud (fire and forget)
    provisionAuthentikUser({ email, name, password }).catch(() => {});
    provisionNextcloudUser({ email, name, password }).catch(() => {});

    // Link referral if code provided
    const authReferralService = getAuthReferralService();
    if (referralCode && authReferralService) {
      try {
        const referrerId = await authReferralService.getUserByCode(referralCode);
        if (referrerId) {
          await authReferralService.linkReferral(referrerId, user.id);
          logger.info('Referral linked on registration', { referrerId, referredId: user.id, referralCode });
        }
      } catch (refErr: any) {
        logger.warn('Failed to link referral on registration', { referralCode, error: refErr.message });
      }
    }

    // Welcome bonus for all new users
    creditWelcomeBonus(user.id);

    // Create verification token and send email
    const verificationToken = await userService.createVerificationToken(user.id);

    const authEmailService = getAuthEmailService();
    if (authEmailService) {
      await authEmailService.sendVerificationEmail(email, verificationToken);
    }

    logger.info('User registered', { userId: user.id, email: maskEmail(email) });

    return res.status(201).json({
      success: true,
      message: 'Registration successful. Please check your email to verify your account.',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    });
  } catch (error: any) {
    logger.error('Error during registration:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'An error occurred during registration',
    });
  }
}

/**
 * Verify email with token
 * Public route
 */
export async function verifyEmail(req: Request, res: Response): Promise<Response> {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Token is required',
      });
    }

    const userService = getUserService();
    const verified = await userService.verifyEmail(token);

    if (!verified) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid or expired verification token',
      });
    }

    logger.info('Email verified successfully');

    return res.json({
      success: true,
      message: 'Email verified successfully. You can now login.',
    });
  } catch (error: any) {
    logger.error('Error verifying email:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'An error occurred during email verification',
    });
  }
}

/**
 * Request password reset
 * Public route
 */
export async function forgotPassword(req: Request, res: Response): Promise<Response> {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Email is required',
      });
    }

    const userService = getUserService();
    const token = await userService.createPasswordResetToken(email);

    // Always return success even if user doesn't exist (security best practice)
    const authEmailService = getAuthEmailService();
    if (token && authEmailService) {
      await authEmailService.sendPasswordResetEmail(email, token);
      logger.info('Password reset requested', { email: maskEmail(email) });
    }

    return res.json({
      success: true,
      message: 'If an account exists with this email, a password reset link has been sent.',
    });
  } catch (error: any) {
    logger.error('Error during password reset request:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'An error occurred during password reset request',
    });
  }
}

/**
 * Reset password with token
 * Public route
 */
export async function resetPassword(req: Request, res: Response): Promise<Response> {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Token and password are required',
      });
    }

    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({
        error: 'Bad Request',
        message: passwordValidation.message,
      });
    }

    const userService = getUserService();
    const success = await userService.resetPassword(token, password);

    if (!success) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid or expired reset token',
      });
    }

    logger.info('Password reset successfully');

    return res.json({
      success: true,
      message: 'Password reset successfully. You can now login with your new password.',
    });
  } catch (error: any) {
    logger.error('Error resetting password:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'An error occurred during password reset',
    });
  }
}
