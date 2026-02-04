/**
 * User Service
 * Handles all user database operations for OAuth authentication
 */

import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';

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
}
