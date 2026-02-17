/**
 * Crypto Tag Required Middleware
 * Checks that the authenticated user has the "crypto" tag assigned by an admin.
 * Returns 403 if the tag is missing.
 */

import { Response, NextFunction } from 'express';
import { BaseDatabase } from '@secondlayer/shared';
import { logger } from '../utils/logger.js';

let dbInstance: BaseDatabase | null = null;

export function initializeCryptoTagMiddleware(db: BaseDatabase): void {
  dbInstance = db;
}

export async function cryptoTagRequired(req: any, res: Response, next: NextFunction): Promise<void> {
  if (!dbInstance) {
    logger.error('cryptoTagRequired: database not initialized');
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  const userId = req.user?.userId || req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const result = await dbInstance.query(
      'SELECT 1 FROM user_tags WHERE user_id = $1 AND tag = $2',
      [userId, 'crypto']
    );

    if (result.rows.length === 0) {
      res.status(403).json({
        error: 'Crypto payments not enabled',
        message: 'Contact an administrator to enable crypto payment options for your account.',
      });
      return;
    }

    next();
  } catch (error: any) {
    logger.error('cryptoTagRequired: failed to check user tag', { error: error.message, userId });
    res.status(500).json({ error: 'Internal server error' });
  }
}
