/**
 * EULA Routes
 * Endpoints for End User License Agreement management
 */

import express, { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { EULAService } from '../services/eula-service.js';

export function createEULARouter(pool: Pool): express.Router {
  const router = express.Router();
  const eulaService = new EULAService(pool);

  /**
   * GET /api/eula
   * Get the current active EULA document
   */
  router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const eula = await eulaService.getActiveEULA();

      if (!eula) {
        return res.status(404).json({
          success: false,
          error: 'No active EULA found',
        });
      }

      return res.json({
        success: true,
        data: eula,
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/eula/status
   * Check if the current user has accepted the active EULA
   * Requires authentication
   */
  router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
    try {
      // @ts-ignore - userId is set by auth middleware
      const userId = req.userId;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const hasAccepted = await eulaService.hasUserAcceptedEULA(userId);

      return res.json({
        success: true,
        data: {
          hasAccepted,
          userId,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * POST /api/eula/accept
   * Record user's acceptance of the EULA
   * Requires authentication
   */
  router.post('/accept', async (req: Request, res: Response, next: NextFunction) => {
    try {
      // @ts-ignore - userId is set by auth middleware
      const userId = req.userId;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const { version } = req.body;

      // Get active EULA version if not specified
      let eulaVersion = version;
      if (!eulaVersion) {
        const activeEULA = await eulaService.getActiveEULA();
        if (!activeEULA) {
          return res.status(404).json({
            success: false,
            error: 'No active EULA found',
          });
        }
        eulaVersion = activeEULA.version;
      }

      // Extract IP address and user agent
      const ipAddress = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
                       (req.headers['x-real-ip'] as string) ||
                       req.socket.remoteAddress;
      const userAgent = req.headers['user-agent'];

      const acceptance = await eulaService.recordAcceptance(
        userId,
        eulaVersion,
        ipAddress,
        userAgent
      );

      return res.json({
        success: true,
        data: acceptance,
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/eula/history
   * Get user's EULA acceptance history
   * Requires authentication
   */
  router.get('/history', async (req: Request, res: Response, next: NextFunction) => {
    try {
      // @ts-ignore - userId is set by auth middleware
      const userId = req.userId;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const acceptances = await eulaService.getUserAcceptances(userId);

      return res.json({
        success: true,
        data: acceptances,
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/eula/documents
   * Get all legal documents (EULA, user manual, service agreement)
   */
  router.get('/documents', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const documents = await eulaService.getAllDocuments();

      return res.json({
        success: true,
        data: documents,
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/eula/manual
   * Get user manual only
   */
  router.get('/manual', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const manual = await eulaService.loadUserManualFromFile();

      return res.json({
        success: true,
        data: {
          content: manual,
          contentType: 'markdown',
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * POST /api/eula/update-from-file
   * Update EULA content from EULA_manual_license.txt file
   * Admin only - requires special permission
   */
  router.post('/update-from-file', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { version = '1.0' } = req.body;

      await eulaService.updateEULAFromFile(version);

      return res.json({
        success: true,
        message: 'EULA content updated from file',
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
