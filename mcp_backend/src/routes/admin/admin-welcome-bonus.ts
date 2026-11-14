/**
 * Admin Welcome Bonus Routes — claims held for review because they look like
 * an earlier claimant (same profile name, browser or recent IP).
 */

import { Router, Request, Response } from 'express';
import type { IDatabase } from '../../domain/ports/index.js';
import type { BillingService } from '../../services/billing-service.js';
import { WelcomeBonusService } from '../../services/welcome-bonus-service.js';
import { logger } from '../../utils/logger.js';
import { getStringParam, type LogAdminAction } from './admin-middleware.js';

export function createAdminWelcomeBonusRoutes(
  db: IDatabase,
  logAdminAction: LogAdminAction,
  billingService: BillingService,
): Router {
  const router = Router();
  const bonus = new WelcomeBonusService(db, billingService);

  /** GET /api/admin/welcome-bonus/pending */
  router.get('/welcome-bonus/pending', async (_req: Request, res: Response) => {
    try {
      res.json({ claims: await bonus.listPending() });
    } catch (error: any) {
      logger.error('Failed to list pending welcome bonus claims', { error: error.message });
      res.status(500).json({ error: 'Failed to list pending claims' });
    }
  });

  /** POST /api/admin/welcome-bonus/:userId/approve | /reject */
  for (const action of ['approve', 'reject'] as const) {
    router.post(`/welcome-bonus/:userId/${action}`, async (req: Request, res: Response) => {
      const userId = getStringParam(req.params.userId);
      const adminId = (req as any).user?.id;
      if (!userId) return res.status(400).json({ error: 'userId is required' });
      try {
        const done = action === 'approve'
          ? await bonus.approve(userId, adminId)
          : await bonus.reject(userId, adminId);
        if (!done) return res.status(404).json({ error: 'No pending claim for this user' });
        await logAdminAction(adminId, `welcome_bonus_${action}`, userId, null, {}, req);
        res.json({ success: true });
      } catch (error: any) {
        logger.error(`Failed to ${action} welcome bonus claim`, { userId, error: error.message });
        res.status(500).json({ error: `Failed to ${action} claim` });
      }
    });
  }

  return router;
}
