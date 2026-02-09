import { Response, NextFunction } from 'express';
import { AuthenticatedRequest as DualAuthRequest } from './dual-auth.js';
import { MatterService } from '../services/matter-service.js';
import { logger } from '../utils/logger.js';

let matterService: MatterService | null = null;

export function initializeMatterAccess(service: MatterService): void {
  matterService = service;
}

/**
 * Middleware to check matter access.
 * Extracts matter_id from params/body/query.
 * If absent → next() (backward compatible).
 * If present → verifies user is on matter_team or is org admin/owner.
 * Attaches req.matterId on success.
 */
export function requireMatterAccess() {
  return async (req: DualAuthRequest & { matterId?: string }, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!matterService) {
        logger.error('[MatterAccess] Service not initialized');
        res.status(500).json({ error: 'Matter access service not initialized' });
        return;
      }

      const matterId = req.params.matterId || req.body?.matter_id || req.query?.matter_id;

      if (!matterId) {
        // No matter context — backward compatible, pass through
        next();
        return;
      }

      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      // Check if user is on this matter's team
      const isOnMatter = await matterService.isUserOnMatter(matterId, userId);
      if (isOnMatter) {
        req.matterId = matterId;
        next();
        return;
      }

      // Check if user is org admin/owner
      const orgId = await matterService.getUserOrgId(userId);
      if (orgId) {
        const isAdmin = await matterService.isOrgAdmin(orgId, userId);
        if (isAdmin) {
          req.matterId = matterId;
          next();
          return;
        }
      }

      logger.warn('[MatterAccess] Access denied', { userId, matterId });
      res.status(403).json({ error: 'You do not have access to this matter' });
    } catch (error: any) {
      logger.error('[MatterAccess] Error checking access', { error: error.message });
      res.status(500).json({ error: 'Failed to verify matter access' });
    }
  };
}
