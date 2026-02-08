/**
 * User Service
 * Handles all user database operations for OAuth authentication
 */

import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

export interface User {
  id: string;
  google_id: string;
  email: string;
  name?: string;
  picture?: string;
  email_verified: boolean;
  locale?: string;
  last_login?: Date;
  created_at: Date;
  updated_at: Date;
  password_hash?: string;
}

export interface UserCreate {
  googleId: string;
  email: string;
  name?: string;
  picture?: string;
  emailVerified?: boolean;
  locale?: string;
}

export interface UserCreateWithPassword {
  email: string;
  password: string;
  name?: string;
}

export interface UserSession {
  id: string;
  user_id: string;
  session_token: string;
  expires_at: Date;
  created_at: Date;
}

export class UserService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Find user by Google ID
   */
  async findByGoogleId(googleId: string): Promise<User | null> {
    try {
      const result = await this.db.query(
        'SELECT * FROM users WHERE google_id = $1',
        [googleId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0] as User;
    } catch (error) {
      logger.error('Error finding user by Google ID:', error);
      throw error;
    }
  }

  /**
   * Find user by email
   */
  async findByEmail(email: string): Promise<User | null> {
    try {
      const result = await this.db.query(
        'SELECT * FROM users WHERE email = $1',
        [email]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0] as User;
    } catch (error) {
      logger.error('Error finding user by email:', error);
      throw error;
    }
  }

  /**
   * Find user by ID
   */
  async findById(userId: string): Promise<User | null> {
    try {
      const result = await this.db.query(
        'SELECT * FROM users WHERE id = $1',
        [userId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0] as User;
    } catch (error) {
      logger.error('Error finding user by ID:', error);
      throw error;
    }
  }

  /**
   * Create new user
   */
  async createUser(data: UserCreate): Promise<User> {
    try {
      const result = await this.db.query(
        `INSERT INTO users (google_id, email, name, picture, email_verified, locale)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          data.googleId,
          data.email,
          data.name || null,
          data.picture || null,
          data.emailVerified !== undefined ? data.emailVerified : false,
          data.locale || null,
        ]
      );

      const user = result.rows[0] as User;
      logger.info('Created new user:', { userId: user.id, email: user.email });
      return user;
    } catch (error) {
      logger.error('Error creating user:', error);
      throw error;
    }
  }

  /**
   * Link Google account to existing user
   */
  async linkGoogleAccount(userId: string, googleId: string): Promise<User> {
    try {
      const result = await this.db.query(
        `UPDATE users
         SET google_id = $1, email_verified = TRUE, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING *`,
        [googleId, userId]
      );

      const user = result.rows[0] as User;
      logger.info('Linked Google account to user:', { userId, email: user.email });
      return user;
    } catch (error) {
      logger.error('Error linking Google account:', error);
      throw error;
    }
  }

  /**
   * Update last login timestamp
   */
  async updateLastLogin(userId: string): Promise<void> {
    try {
      await this.db.query(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
        [userId]
      );
      logger.debug('Updated last login for user:', { userId });
    } catch (error) {
      logger.error('Error updating last login:', error);
      // Don't throw - this is not critical
    }
  }

  /**
   * Update user profile (name, picture, etc.)
   */
  async updateProfile(userId: string, updates: { name?: string; picture?: string }): Promise<User> {
    try {
      // Build dynamic query based on provided fields
      const fields: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (updates.name !== undefined) {
        fields.push(`name = $${paramIndex++}`);
        values.push(updates.name);
      }

      if (updates.picture !== undefined) {
        fields.push(`picture = $${paramIndex++}`);
        values.push(updates.picture);
      }

      // Always update the updated_at timestamp
      fields.push('updated_at = CURRENT_TIMESTAMP');

      if (fields.length === 1) {
        // Only updated_at, no actual changes
        const user = await this.findById(userId);
        if (!user) {
          throw new Error('User not found');
        }
        return user;
      }

      // Add userId as the last parameter
      values.push(userId);

      const query = `
        UPDATE users
        SET ${fields.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING *
      `;

      const result = await this.db.query(query, values);

      if (result.rows.length === 0) {
        throw new Error('User not found');
      }

      const user = result.rows[0] as User;
      logger.info('Updated user profile:', { userId: user.id, updates });
      return user;
    } catch (error) {
      logger.error('Error updating user profile:', error);
      throw error;
    }
  }

  /**
   * Create session for user
   */
  async createSession(userId: string, sessionToken: string, expiresAt: Date): Promise<UserSession> {
    try {
      const result = await this.db.query(
        `INSERT INTO user_sessions (user_id, session_token, expires_at)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [userId, sessionToken, expiresAt]
      );

      logger.debug('Created session for user:', { userId });
      return result.rows[0] as UserSession;
    } catch (error) {
      logger.error('Error creating session:', error);
      throw error;
    }
  }

  /**
   * Validate session and return user
   */
  async validateSession(sessionToken: string): Promise<User | null> {
    try {
      const result = await this.db.query(
        `SELECT u.* FROM users u
         INNER JOIN user_sessions s ON u.id = s.user_id
         WHERE s.session_token = $1 AND s.expires_at > CURRENT_TIMESTAMP`,
        [sessionToken]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0] as User;
    } catch (error) {
      logger.error('Error validating session:', error);
      throw error;
    }
  }

  /**
   * Delete session (logout)
   */
  async deleteSession(sessionToken: string): Promise<void> {
    try {
      await this.db.query(
        'DELETE FROM user_sessions WHERE session_token = $1',
        [sessionToken]
      );
      logger.debug('Deleted session');
    } catch (error) {
      logger.error('Error deleting session:', error);
      // Don't throw - session might not exist
    }
  }

  /**
   * Clean up expired sessions (should be run periodically)
   */
  async cleanupExpiredSessions(): Promise<number> {
    try {
      const result = await this.db.query(
        'DELETE FROM user_sessions WHERE expires_at < CURRENT_TIMESTAMP'
      );
      const count = result.rowCount || 0;
      logger.info('Cleaned up expired sessions:', { count });
      return count;
    } catch (error) {
      logger.error('Error cleaning up sessions:', error);
      return 0;
    }
  }

  /**
   * Create a new user with email and password (not OAuth)
   */
  async createUserWithPassword(data: UserCreateWithPassword): Promise<User> {
    try {
      const passwordHash = await bcrypt.hash(data.password, 10);
      const result = await this.db.query(
        `INSERT INTO users (email, name, password_hash, email_verified)
         VALUES ($1, $2, $3, FALSE)
         RETURNING *`,
        [data.email, data.name || null, passwordHash]
      );

      const user = result.rows[0] as User;
      logger.info('Created new user with password:', { userId: user.id, email: user.email });
      return user;
    } catch (error) {
      logger.error('Error creating user with password:', error);
      throw error;
    }
  }

  /**
   * Create email verification token
   */
  async createVerificationToken(userId: string): Promise<string> {
    try {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      await this.db.query(
        `INSERT INTO email_verification_tokens (user_id, token, expires_at)
         VALUES ($1, $2, $3)`,
        [userId, token, expiresAt]
      );

      logger.debug('Created verification token for user:', { userId });
      return token;
    } catch (error) {
      logger.error('Error creating verification token:', error);
      throw error;
    }
  }

  /**
   * Verify email using token
   */
  async verifyEmail(token: string): Promise<boolean> {
    try {
      const result = await this.db.query(
        `SELECT user_id, expires_at FROM email_verification_tokens
         WHERE token = $1 AND used_at IS NULL`,
        [token]
      );

      if (result.rows.length === 0) return false;

      const { user_id, expires_at } = result.rows[0];

      if (new Date() > new Date(expires_at)) {
        return false;
      }

      // Mark token as used and verify user in a transaction
      await this.db.query('BEGIN');
      try {
        await this.db.query(
          `UPDATE email_verification_tokens SET used_at = CURRENT_TIMESTAMP WHERE token = $1`,
          [token]
        );
        await this.db.query(
          `UPDATE users SET email_verified = TRUE WHERE id = $1`,
          [user_id]
        );
        await this.db.query('COMMIT');
      } catch (err) {
        await this.db.query('ROLLBACK');
        throw err;
      }

      logger.info('Email verified for user:', { userId: user_id });
      return true;
    } catch (error) {
      logger.error('Error verifying email:', error);
      throw error;
    }
  }

  /**
   * Create password reset token for a user
   */
  async createPasswordResetToken(email: string): Promise<string | null> {
    try {
      const user = await this.findByEmail(email);
      if (!user) return null;

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 1 * 60 * 60 * 1000); // 1 hour

      await this.db.query(
        `INSERT INTO password_reset_tokens (user_id, token, expires_at)
         VALUES ($1, $2, $3)`,
        [user.id, token, expiresAt]
      );

      logger.debug('Created password reset token for user:', { userId: user.id });
      return token;
    } catch (error) {
      logger.error('Error creating password reset token:', error);
      throw error;
    }
  }

  /**
   * Reset password using token
   */
  async resetPassword(token: string, newPassword: string): Promise<boolean> {
    try {
      const result = await this.db.query(
        `SELECT user_id, expires_at FROM password_reset_tokens
         WHERE token = $1 AND used_at IS NULL`,
        [token]
      );

      if (result.rows.length === 0) return false;

      const { user_id, expires_at } = result.rows[0];

      if (new Date() > new Date(expires_at)) {
        return false;
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);

      await this.db.query('BEGIN');
      try {
        await this.db.query(
          `UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE token = $1`,
          [token]
        );
        await this.db.query(
          `UPDATE users SET password_hash = $1 WHERE id = $2`,
          [passwordHash, user_id]
        );
        await this.db.query('COMMIT');
      } catch (err) {
        await this.db.query('ROLLBACK');
        throw err;
      }

      logger.info('Password reset for user:', { userId: user_id });
      return true;
    } catch (error) {
      logger.error('Error resetting password:', error);
      throw error;
    }
  }

  /**
   * Record a failed login attempt and lock account after 5 failures
   */
  async recordFailedLogin(email: string): Promise<void> {
    try {
      await this.db.query(
        `UPDATE users
         SET failed_login_attempts = COALESCE(failed_login_attempts, 0) + 1,
             locked_until = CASE
               WHEN COALESCE(failed_login_attempts, 0) + 1 >= 5
               THEN CURRENT_TIMESTAMP + INTERVAL '15 minutes'
               ELSE locked_until
             END
         WHERE email = $1`,
        [email]
      );
    } catch (error) {
      logger.error('Error recording failed login:', error);
    }
  }

  /**
   * Reset failed login attempts after successful login
   */
  async resetFailedAttempts(userId: string): Promise<void> {
    try {
      await this.db.query(
        `UPDATE users
         SET failed_login_attempts = 0, locked_until = NULL
         WHERE id = $1`,
        [userId]
      );
    } catch (error) {
      logger.error('Error resetting failed attempts:', error);
    }
  }

  /**
   * Check if account is locked due to too many failed login attempts
   */
  async isAccountLocked(email: string): Promise<boolean> {
    try {
      const result = await this.db.query(
        `SELECT locked_until FROM users WHERE email = $1`,
        [email]
      );

      if (result.rows.length === 0) return false;

      const lockedUntil = result.rows[0].locked_until;
      if (!lockedUntil) return false;

      return new Date() < new Date(lockedUntil);
    } catch (error) {
      logger.error('Error checking account lock:', error);
      return false;
    }
  }
}
