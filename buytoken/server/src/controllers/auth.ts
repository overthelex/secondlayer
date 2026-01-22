/**
 * Authentication Controller
 * Business logic for user authentication
 */

import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import passport from '../config/passport.js';
import { pool } from '../config/database.js';
import { generateToken } from '../middleware/auth.js';
import {
  RegisterRequest,
  LoginRequest,
  ValidationError,
  UnauthorizedError,
  User,
} from '../types/index.js';

export async function register(req: Request, res: Response) {
  const { email, password, name } = req.body as RegisterRequest;

  // Validation
  if (!email || !password) {
    throw new ValidationError('Email and password are required');
  }

  // Check if user already exists
  const existingUser = await pool.query(
    'SELECT id FROM users WHERE email = $1',
    [email]
  );

  if (existingUser.rows.length > 0) {
    throw new ValidationError('Email already registered');
  }

  // Hash password
  const password_hash = await bcrypt.hash(password, 10);

  // Create user
  const result = await pool.query(
    `INSERT INTO users (email, name, password_hash, role, email_verified)
     VALUES ($1, $2, $3, 'user', false)
     RETURNING id, email, name, role, created_at`,
    [email, name || null, password_hash]
  );

  const user = result.rows[0];

  // Generate JWT token
  const token = generateToken(user);

  res.status(201).json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  });
}

export async function login(req: Request, res: Response) {
  const { email, password } = req.body as LoginRequest;

  // Validation
  if (!email || !password) {
    throw new ValidationError('Email and password are required');
  }

  // Find user
  const result = await pool.query(
    'SELECT * FROM users WHERE email = $1',
    [email]
  );

  if (result.rows.length === 0) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const user = result.rows[0];

  // Check password
  if (!user.password_hash) {
    throw new UnauthorizedError('This account uses OAuth. Please sign in with Google.');
  }

  const isValidPassword = await bcrypt.compare(password, user.password_hash);

  if (!isValidPassword) {
    throw new UnauthorizedError('Invalid email or password');
  }

  // Generate JWT token
  const token = generateToken(user);

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  });
}

export async function logout(req: Request, res: Response) {
  // With JWT, logout is handled client-side by deleting the token
  res.json({ message: 'Logged out successfully' });
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
export async function googleOAuthCallback(req: Request, res: Response) {
  // Passport will have attached user to req.user
  const user = req.user as User;

  if (!user) {
    // OAuth failed
    return res.redirect(`http://localhost:3001/index.html?error=oauth_failed`);
  }

  // Generate JWT token for the user
  const token = generateToken(user);

  // Get user's token balance
  const balanceResult = await pool.query(
    'SELECT balance FROM user_token_balance WHERE user_id = $1',
    [user.id]
  );

  const balance = balanceResult.rows[0]?.balance || 0;

  // Redirect to frontend with token in URL (or use a different method)
  // In production, consider using a more secure method (e.g., setting httpOnly cookie)
  const redirectUrl = `http://localhost:3001/profile.html?token=${token}&uid=${user.id}&email=${encodeURIComponent(user.email)}&balance=${balance}`;

  res.redirect(redirectUrl);
}

export async function refreshToken(req: Request, res: Response) {
  // TODO: Implement token refresh
  res.status(501).json({ message: 'Token refresh not yet implemented' });
}

export async function forgotPassword(req: Request, res: Response) {
  // TODO: Implement password reset email
  res.status(501).json({ message: 'Password reset not yet implemented' });
}

export async function resetPassword(req: Request, res: Response) {
  // TODO: Implement password reset
  res.status(501).json({ message: 'Password reset not yet implemented' });
}

export async function verifyEmail(req: Request, res: Response) {
  // TODO: Implement email verification
  res.status(501).json({ message: 'Email verification not yet implemented' });
}
