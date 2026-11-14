/**
 * Auth OIDC — OIDC/Authentik SSO handlers
 */

import { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { getUserService } from '../middleware/dual-auth.js';
import * as oidcService from '../services/oidc-service.js';
import { provisionNextcloudUser } from '../services/nextcloud-provisioning.js';
import {
  generateToken,
  generateBannerAsync,
} from './auth-common.js';

/**
 * GET /auth/oidc
 * Initiates OIDC authorization code flow.
 * Redirects user to Authentik login page.
 */
export async function oidcAuthInit(req: Request, res: Response): Promise<void> {
  try {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const callbackUrl = `${protocol}://${host}/auth/oidc/callback`;

    const { url } = await oidcService.getAuthorizationUrl(callbackUrl);
    res.redirect(url);
  } catch (error: any) {
    logger.error('[OIDC] Auth init failed:', error);
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    res.redirect(`${protocol}://${host}/login?error=oidc_failed`);
  }
}

/**
 * GET /auth/oidc/callback
 * Handles callback from Authentik after user authenticates.
 */
export async function oidcAuthCallback(req: Request, res: Response): Promise<void> {
  try {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const frontendUrl = `${protocol}://${host}`;
    const callbackUrl = `${frontendUrl}/auth/oidc/callback`;

    const queryParams: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === 'string') queryParams[key] = value;
    }

    if (queryParams.error) {
      logger.error('[OIDC] Provider returned error', {
        error: queryParams.error,
        description: queryParams.error_description,
      });
      res.redirect(`${frontendUrl}/login?error=oidc_failed`);
      return;
    }

    const userInfo = await oidcService.handleCallback(callbackUrl, queryParams);
    const userService = getUserService();

    let user = await userService.findByEmail(userInfo.email);

    if (user) {
      await userService.updateLastLogin(user.id);
      logger.info('[OIDC] Existing user logged in via SSO', {
        userId: user.id,
        email: user.email,
      });
    } else {
      user = await userService.createUser({
        googleId: '',
        email: userInfo.email,
        name: userInfo.name || userInfo.email.split('@')[0],
        picture: userInfo.picture,
        emailVerified: userInfo.email_verified ?? true,
      });
      await userService.updateLastLogin(user.id);
      logger.info('[OIDC] New user created via SSO', {
        userId: user.id,
        email: user.email,
      });

      generateBannerAsync(user.id, user.name || user.email);
      provisionNextcloudUser({ email: userInfo.email, name: userInfo.name }).catch(() => {});
    }

    const token = generateToken(user);
    res.redirect(`${frontendUrl}/login?token=${token}`);
  } catch (error: any) {
    logger.error('[OIDC] Callback failed:', error);
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    res.redirect(`${protocol}://${host}/login?error=oidc_failed`);
  }
}

/**
 * POST /auth/oidc/login
 * SSO login with email/password via Authentik ROPC grant.
 */
export async function oidcLoginWithPassword(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ message: 'Email та пароль обов\'язкові' });
      return;
    }

    if (!oidcService.isOidcConfigured()) {
      res.status(501).json({ message: 'SSO не налаштовано' });
      return;
    }

    const userInfo = await oidcService.loginWithCredentials(email, password);
    const userService = getUserService();

    let user = await userService.findByEmail(userInfo.email);

    if (user) {
      await userService.updateLastLogin(user.id);
      logger.info('[OIDC] Existing user logged in via SSO (ROPC)', {
        userId: user.id,
        email: user.email,
      });
    } else {
      user = await userService.createUser({
        googleId: '',
        email: userInfo.email,
        name: userInfo.name || userInfo.email.split('@')[0],
        picture: userInfo.picture,
        emailVerified: userInfo.email_verified ?? true,
      });
      await userService.updateLastLogin(user.id);
      logger.info('[OIDC] New user created via SSO (ROPC)', {
        userId: user.id,
        email: user.email,
      });

      generateBannerAsync(user.id, user.name || user.email);
      provisionNextcloudUser({ email: userInfo.email, name: userInfo.name }).catch(() => {});
    }

    const token = generateToken(user);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, picture: user.picture } });
  } catch (error: any) {
    logger.error('[OIDC] ROPC login failed:', error);

    const msg = error.message?.includes('invalid_grant')
      ? 'Невірний email або пароль'
      : error.message?.includes('Unexpected flow stage')
        ? 'Непідтримуваний крок автентифікації (можливо, потрібна MFA)'
        : 'Помилка автентифікації через SSO';

    res.status(401).json({ message: msg });
  }
}
