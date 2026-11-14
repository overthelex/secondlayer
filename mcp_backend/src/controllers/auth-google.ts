/**
 * Auth Google — Google OAuth handlers (web + mobile callback)
 */

import { Request, Response } from 'express';
import passport from 'passport';
import { OAuth2Client } from 'google-auth-library';
import { logger } from '../utils/logger.js';
import { getUserService } from '../middleware/dual-auth.js';
import { provisionAuthentikUser } from '../services/authentik-service.js';
import { provisionNextcloudUser } from '../services/nextcloud-provisioning.js';
import {
  type AuthenticatedRequest,
  generateToken,
  generateBannerAsync,
  FRONTEND_URL,
} from './auth-common.js';

/**
 * Initiate Google OAuth2 flow
 * Redirects user to Google login page
 */
export const googleOAuthInit = passport.authenticate('google', {
  scope: ['profile', 'email'],
  session: false,
});

/**
 * Google OAuth2 callback handler
 * Creates/links user account and returns JWT token
 */
export async function googleOAuthCallback(req: AuthenticatedRequest, res: Response) {
  try {
    // Determine frontend URL from request origin (supports multiple domains)
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const frontendUrl = `${protocol}://${host}`;

    // Passport will have attached user to req.user
    const user = req.user;

    if (!user) {
      // OAuth failed
      logger.error('OAuth callback failed - no user in request');
      return res.redirect(`${frontendUrl}/login?error=oauth_failed`);
    }

    // Generate JWT token for the user
    const token = generateToken(user);

    logger.info('Google OAuth successful', {
      userId: user.id,
      email: user.email,
    });

    // Redirect to frontend with token in URL
    const redirectUrl = `${frontendUrl}/login?token=${token}`;
    return res.redirect(redirectUrl);
  } catch (error: any) {
    logger.error('Error in OAuth callback:', error);
    return res.redirect(`${FRONTEND_URL}/login?error=server_error`);
  }
}

/**
 * Google Mobile Auth — verifies idToken from Google Sign-In SDK
 * Used by mobile apps that handle Google sign-in natively
 *
 * @route  POST /auth/google/mobile
 * @body   { idToken: string, accessToken?: string }
 * @returns { token, refreshToken, user }
 */
export async function googleMobileAuth(req: Request, res: Response): Promise<Response> {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: 'idToken is required' });
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return res.status(501).json({ error: 'Google OAuth is not configured on server' });
    }

    // Accept the primary web client id plus any additional mobile client ids
    // (comma-separated in GOOGLE_MOBILE_CLIENT_IDS) — e.g. a native iOS/Android
    // OAuth client whose issued idToken carries a different audience. This is
    // additive: the web (passport) login keeps using GOOGLE_CLIENT_ID only.
    const extraMobileIds = (process.env.GOOGLE_MOBILE_CLIENT_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const allowedAudiences = [clientId, ...extraMobileIds];

    // Verify the idToken with Google
    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({
      idToken,
      audience: allowedAudiences,
    });
    const payload = ticket.getPayload();

    if (!payload || !payload.email) {
      return res.status(401).json({ error: 'Invalid Google token — no email in payload' });
    }

    const googleId = payload.sub;
    const email = payload.email;
    const name = payload.name || email.split('@')[0];
    const picture = payload.picture;

    logger.info('Google mobile auth received', { email, googleId });

    const userService = getUserService();

    // 1. Check by Google ID
    let user = await userService.findByGoogleId(googleId);

    if (!user) {
      // 2. Check by email (account linking)
      user = await userService.findByEmail(email);

      if (user) {
        logger.info('Linking Google account to existing user (mobile)', { email, userId: user.id });
        user = await userService.linkGoogleAccount(user.id, googleId);
      } else {
        // 3. Create new user
        logger.info('Creating new Google user (mobile)', { email });
        user = await userService.createUser({
          googleId,
          email,
          name,
          picture,
          emailVerified: true,
        });

        // Provision in external services (fire and forget)
        provisionAuthentikUser({ email, name }).catch(() => {});
        provisionNextcloudUser({ email, name }).catch(() => {});
        generateBannerAsync(user.id, user.name || user.email);
      }
    }

    await userService.updateLastLogin(user.id);

    const token = generateToken(user);

    logger.info('Google mobile auth successful', { userId: user.id, email });

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        user_type: user.user_type,
      },
    });
  } catch (error: any) {
    logger.error('Google mobile auth error:', error);

    if (error.message?.includes('Token used too late') || error.message?.includes('Invalid token')) {
      return res.status(401).json({ error: 'Google token expired or invalid' });
    }

    return res.status(500).json({ error: 'Помилка автентифікації' });
  }
}
