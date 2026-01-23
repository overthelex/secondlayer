/**
 * Passport Configuration
 * Google OAuth2 Strategy for user authentication
 */

import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Database } from '../database/database.js';
import { UserService } from '../services/user-service.js';
import { logger } from '../utils/logger.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback';

/**
 * Configure Passport with database instance
 */
export function configurePassport(db: Database): typeof passport {
  const userService = new UserService(db);

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    logger.warn('Google OAuth2 not configured (missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET)');
    return passport;
  }

  // Configure Google OAuth2 Strategy
  passport.use(
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackURL: GOOGLE_CALLBACK_URL,
        scope: ['profile', 'email'],
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          // Extract user info from Google profile
          const googleId = profile.id;
          const email = profile.emails?.[0]?.value;
          const name = profile.displayName;
          const picture = profile.photos?.[0]?.value;
          const locale = profile._json.locale;

          if (!email) {
            logger.error('No email found in Google profile');
            return done(new Error('No email found in Google profile'), undefined);
          }

          logger.info('Google OAuth callback received', { email, googleId });

          // 1. Check if user exists by Google ID
          let user = await userService.findByGoogleId(googleId);

          if (user) {
            // User exists with this Google ID - update last login
            logger.info('Existing Google user logged in', { email, userId: user.id });
            await userService.updateLastLogin(user.id);
            return done(null, user);
          }

          // 2. Check if user exists with this email (account linking)
          user = await userService.findByEmail(email);

          if (user) {
            // User exists with email but no Google ID - link accounts
            logger.info('Linking Google account to existing user', { email, userId: user.id });
            user = await userService.linkGoogleAccount(user.id, googleId);
            await userService.updateLastLogin(user.id);
            return done(null, user);
          }

          // 3. Create new user with Google account
          logger.info('Creating new Google user', { email });
          user = await userService.createUser({
            googleId,
            email,
            name,
            picture,
            emailVerified: true, // Google emails are pre-verified
            locale,
          });

          await userService.updateLastLogin(user.id);
          logger.info('New Google user created', { userId: user.id, email });

          return done(null, user);
        } catch (error: any) {
          logger.error('Google OAuth error:', error);
          return done(error, undefined);
        }
      }
    )
  );

  // Serialize user for session (not used with JWT, but required by Passport)
  passport.serializeUser((user: any, done) => {
    done(null, user.id);
  });

  // Deserialize user from session (not used with JWT, but required by Passport)
  passport.deserializeUser(async (id: string, done) => {
    try {
      const user = await userService.findById(id);
      done(null, user);
    } catch (error) {
      done(error, null);
    }
  });

  logger.info('Passport Google OAuth2 strategy configured', {
    clientId: GOOGLE_CLIENT_ID.substring(0, 20) + '...',
    callbackURL: GOOGLE_CALLBACK_URL,
  });

  return passport;
}

export default passport;
