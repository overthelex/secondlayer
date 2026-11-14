/**
 * Auth Common — Shared types, JWT helpers, singleton setters, validation helpers
 */

import { Request } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../services/user-service.js';
import { logger } from '../utils/logger.js';
import { EmailService } from '../services/email-service.js';
import { MinioService } from '../services/minio-service.js';
import { BannerService } from '../services/banner-service.js';
import type { ICachePort } from '../domain/ports/index.js';
import type { ReferralService } from '../services/referral-service.js';
import type { BillingService } from '../services/billing-service.js';
import { WELCOME_BONUS_UAH } from '../config/welcome-bonus.js';

// ---------------------------------------------------------------------------
// Module-level singletons (shared across all auth sub-modules)
// ---------------------------------------------------------------------------

let authCache: ICachePort | null = null;
let authEmailService: EmailService | null = null;
let authMinioService: MinioService | null = null;
let authBannerService: BannerService | null = null;
let authReferralService: ReferralService | null = null;
let authBillingService: BillingService | null = null;

// Accessors for sub-modules
export function getAuthCache(): ICachePort | null { return authCache; }
export function getAuthEmailService(): EmailService | null { return authEmailService; }
export function getAuthMinioService(): MinioService | null { return authMinioService; }
export function getAuthBannerService(): BannerService | null { return authBannerService; }
export function getAuthReferralService(): ReferralService | null { return authReferralService; }
export function getAuthBillingService(): BillingService | null { return authBillingService; }

/** Set the cache port for WebAuthn challenge storage. Call from composition root. */
export function setAuthCache(cache: ICachePort): void {
  authCache = cache;
}

/** Set the email service for auth-related emails. Call from composition root. */
export function setAuthEmailService(svc: EmailService): void {
  authEmailService = svc;
}

/** Set the MinIO service for avatar storage. Call from composition root. */
export function setAuthMinioService(svc: MinioService): void {
  authMinioService = svc;
}

/** Set the banner service for profile banner generation. Call from composition root. */
export function setAuthBannerService(svc: BannerService): void {
  authBannerService = svc;
}

/** Set the referral service for linking referrals on registration. Call from composition root. */
export function setAuthReferralService(svc: ReferralService): void {
  authReferralService = svc;
}

/** Set the billing service for welcome bonus on registration. Call from composition root. */
export function setAuthBillingService(svc: BillingService): void {
  authBillingService = svc;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const _jwtSecret = process.env.JWT_SECRET;
if (!_jwtSecret) {
  throw new Error('FATAL: JWT_SECRET environment variable is required');
}
export const JWT_SECRET: string = _jwtSecret;
export const JWT_EXPIRES_IN = '7d'; // 7 days
export const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

export const AVATAR_BUCKET = 'avatars';
export const AVATAR_MAX_SIZE = 512; // px
export const AVATAR_QUALITY = 80;
export const SUPPORTED_IMAGE_FORMATS = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'image/bmp', 'image/tiff', 'image/avif', 'image/heif', 'image/heic',
  'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthenticatedRequest extends Request {
  user?: User;
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

/**
 * Generate JWT token for user
 */
export function generateToken(user: User): string {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      googleId: user.google_id,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256' }
  );
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function validatePassword(password: string): { valid: boolean; message?: string } {
  if (password.length < 8) {
    return { valid: false, message: 'Password must be at least 8 characters long' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one uppercase letter' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one lowercase letter' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one number' };
  }
  return { valid: true };
}

export function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,10}$/;
  return emailRegex.test(email);
}

// ---------------------------------------------------------------------------
// Async banner helper
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget banner generation for a new user.
 * Logs errors but never throws.
 */
export function generateBannerAsync(userId: string, name: string): void {
  if (!authBannerService) return;
  authBannerService.generateBanner(userId, name).catch((err) => {
    logger.error('[Banner] Async generation failed', { userId, error: err.message });
  });
}

// ---------------------------------------------------------------------------
// Welcome bonus for new users
// ---------------------------------------------------------------------------


/**
 * Credit welcome bonus (430 UAH / ~$10 USD) to a newly registered user.
 * Fire-and-forget — logs errors but never throws.
 */
export function creditWelcomeBonus(userId: string): void {
  const billingService = authBillingService;
  if (!billingService) {
    logger.warn('[WelcomeBonus] Billing service not available', { userId });
    return;
  }

  (async () => {
    await billingService.getOrCreateUserBilling(userId);
    const amountUsd = await billingService.convertFromUah(WELCOME_BONUS_UAH);
    await billingService.topUpBalance({
      userId,
      amountUsd,
      amountUah: WELCOME_BONUS_UAH,
      description: `Вітальний бонус — ${WELCOME_BONUS_UAH} грн`,
      paymentProvider: 'adjustment',
      paymentId: `welcome-${userId}`,
    });
    logger.info('[WelcomeBonus] Credited', { userId, amountUah: WELCOME_BONUS_UAH, amountUsd });
  })().catch((err: any) => {
    logger.warn('[WelcomeBonus] Failed to credit', { userId, error: err.message });
  });
}
