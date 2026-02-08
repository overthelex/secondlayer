/**
 * Authentication Controller
 * Handles OAuth callbacks, JWT generation, and user sessions
 */

import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import passport from 'passport';
import bcrypt from 'bcryptjs';
import { User } from '../services/user-service.js';
import { logger } from '../utils/logger.js';
import { getUserService } from '../middleware/dual-auth.js';
import { EmailService } from '../services/email-service.js';

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const JWT_EXPIRES_IN = '7d'; // 7 days
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

export interface AuthenticatedRequest extends Request {
  user?: User;
}

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
    { expiresIn: JWT_EXPIRES_IN }
  );
}

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
    // Passport will have attached user to req.user
    const user = req.user;

    if (!user) {
      // OAuth failed
      logger.error('OAuth callback failed - no user in request');
      return res.redirect(`${FRONTEND_URL}/login?error=oauth_failed`);
    }

    // Generate JWT token for the user
    const token = generateToken(user);

    logger.info('Google OAuth successful', {
      userId: user.id,
      email: user.email,
    });

    // Redirect to frontend with token in URL
    // In production, consider using httpOnly cookies for better security
    const redirectUrl = `${FRONTEND_URL}/login?token=${token}`;
    return res.redirect(redirectUrl);
  } catch (error: any) {
    logger.error('Error in OAuth callback:', error);
    return res.redirect(`${FRONTEND_URL}/login?error=server_error`);
  }
}

/**
 * Get current user profile
 * Protected route - requires JWT authentication
 */
export async function getCurrentUser(req: AuthenticatedRequest, res: Response): Promise<Response> {
  try {
    const user = req.user;

    if (!user) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'No user found in request',
      });
    }

    // Return user profile without sensitive data
    return res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        emailVerified: user.email_verified,
        lastLogin: user.last_login,
        createdAt: user.created_at,
      },
    });
  } catch (error: any) {
    logger.error('Error getting current user:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
}

/**
 * Logout user
 * With JWT, logout is handled client-side by deleting the token
 * This endpoint can be used for logging or session cleanup
 */
export async function logout(req: AuthenticatedRequest, res: Response): Promise<Response> {
  try {
    const user = req.user;

    if (user) {
      logger.info('User logged out', { userId: user.id, email: user.email });
    }

    return res.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error: any) {
    logger.error('Error during logout:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
}

/**
 * Refresh JWT token
 * Takes an existing valid token and issues a new one
 */
export async function refreshToken(req: Request, res: Response): Promise<Response> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'No token provided',
      });
    }

    const token = authHeader.replace('Bearer ', '');

    // Verify existing token
    const decoded = jwt.verify(token, JWT_SECRET) as any;

    // Create new token with same payload but fresh expiry
    const newToken = jwt.sign(
      {
        userId: decoded.userId,
        email: decoded.email,
        googleId: decoded.googleId,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    logger.info('Token refreshed', { userId: decoded.userId });

    return res.json({
      token: newToken,
      expiresIn: JWT_EXPIRES_IN,
    });
  } catch (error: any) {
    logger.error('Error refreshing token:', error);

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Token has expired. Please login again.',
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid token',
      });
    }

    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
}

/**
 * Update user profile
 * Protected route - requires JWT authentication
 * Allows users to update their name and picture
 */
export async function updateProfile(req: AuthenticatedRequest, res: Response): Promise<Response> {
  try {
    const user = req.user;

    if (!user) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'No user found in request',
      });
    }

    // Extract allowed update fields
    const { name, picture } = req.body;

    // Validate at least one field is provided
    if (name === undefined && picture === undefined) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'At least one field (name or picture) must be provided',
      });
    }

    // Validate name if provided
    if (name !== undefined) {
      if (typeof name !== 'string') {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Name must be a string',
        });
      }
      if (name.trim().length === 0) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Name cannot be empty',
        });
      }
      if (name.length > 255) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Name cannot exceed 255 characters',
        });
      }
    }

    // Validate picture if provided
    if (picture !== undefined) {
      if (typeof picture !== 'string' && picture !== null) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Picture must be a string URL or null',
        });
      }
      if (picture && picture.length > 500) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Picture URL cannot exceed 500 characters',
        });
      }
    }

    // Update user profile
    const userService = getUserService();
    const updates: { name?: string; picture?: string } = {};

    if (name !== undefined) {
      updates.name = name.trim();
    }
    if (picture !== undefined) {
      updates.picture = picture;
    }

    const updatedUser = await userService.updateProfile(user.id, updates);

    logger.info('User profile updated', {
      userId: user.id,
      email: user.email,
      updates,
    });

    // Return updated user profile
    return res.json({
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        name: updatedUser.name,
        picture: updatedUser.picture,
        emailVerified: updatedUser.email_verified,
        lastLogin: updatedUser.last_login,
        createdAt: updatedUser.created_at,
        updatedAt: updatedUser.updated_at,
      },
    });
  } catch (error: any) {
    logger.error('Error updating profile:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
}

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
      logger.warn('Failed login attempt', { email });
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid email or password',
      });
    }

    // Reset failed attempts on successful login
    await userService.resetFailedAttempts(user.id);

    // Update last login
    await userService.updateLastLogin(user.id);

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
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        emailVerified: user.email_verified,
        lastLogin: user.last_login,
        createdAt: user.created_at,
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

// Password validation helper
function validatePassword(password: string): { valid: boolean; message?: string } {
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

// Email validation helper
function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Register new user with email and password
 * Public route
 */
export async function registerWithPassword(req: Request, res: Response): Promise<Response> {
  try {
    const { email, password, name } = req.body;

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

    // Create verification token and send email
    const verificationToken = await userService.createVerificationToken(user.id);

    const emailService = new EmailService();
    await emailService.sendVerificationEmail(email, verificationToken);

    logger.info('User registered', { userId: user.id, email });

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
    if (token) {
      const emailService = new EmailService();
      await emailService.sendPasswordResetEmail(email, token);
      logger.info('Password reset requested', { email });
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
