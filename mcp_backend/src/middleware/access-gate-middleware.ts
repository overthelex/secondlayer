/**
 * Access Gate Middleware
 *
 * Express middleware that blocks chat and upload requests for users who are
 * not beta testers / administrators and have not topped up via Monobank.
 *
 * Returns 403 Forbidden with a structured payload that the frontend can
 * detect (`code: 'BETA_RESTRICTED'`) to surface the beta-only modal.
 */

import { Response, NextFunction } from 'express';
import type { IDatabase } from '../domain/ports/index.js';
import { logger } from '../utils/logger.js';
import { AuthenticatedRequest as DualAuthRequest } from './dual-auth.js';
import { evaluateAccessGate } from '../services/access-gate.js';

export interface AccessGateOptions {
  /**
   * Short label used in logs (e.g. 'chat', 'upload').
   */
  feature: string;
}

/**
 * Build a middleware that denies access unless the request belongs to a beta
 * tester, an administrator, or a user who has topped up via Monobank.
 *
 * API key callers (`req.authType === 'apikey'`) are passed through — they
 * authenticate as service accounts and are not subject to the beta gate.
 */
export function createAccessGate(db: IDatabase, options: AccessGateOptions) {
  return async (req: DualAuthRequest, res: Response, next: NextFunction): Promise<void> => {
    if (req.authType === 'apikey') {
      next();
      return;
    }

    const decision = await evaluateAccessGate(db, req.user);

    if (decision.allowed) {
      next();
      return;
    }

    if (decision.reason === 'unauthenticated') {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'User authentication required',
        code: 'UNAUTHENTICATED',
      });
      return;
    }

    logger.warn('[AccessGate] Blocked request', {
      feature: options.feature,
      userId: req.user?.id,
      email: req.user?.email,
      reason: decision.reason,
    });

    res.status(403).json({
      error: 'Beta access required',
      code: 'BETA_RESTRICTED',
      message:
        'Щоб продовжити, прив\'яжіть картку й отримайте вітальний бонус ' +
        'або поповніть баланс через Monobank.',
      feature: options.feature,
      topup_url: '/billing',
    });
  };
}
