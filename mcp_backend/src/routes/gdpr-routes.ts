import { Router, Response } from 'express';
import { GdprService } from '../services/gdpr-service.js';
import { AuthenticatedRequest as DualAuthRequest } from '../middleware/dual-auth.js';
import { logger } from '../utils/logger.js';

export function createGdprRouter(gdprService: GdprService): Router {
  const router = Router();

  // POST /export - Request data export
  router.post('/export', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const request = await gdprService.requestExport(userId);
      res.status(202).json({
        id: request.id,
        status: request.status,
        message: 'Export request submitted. Data will be available shortly.',
      });
    } catch (error: any) {
      logger.error('[GDPR] Export request failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // GET /export/:id - Get export status / download
  router.get('/export/:id', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const request = await gdprService.getExportData(req.params.id as string, userId);
      if (!request) return res.status(404).json({ error: 'Export request not found' });

      if (request.status === 'completed' && request.metadata) {
        const metadata = typeof request.metadata === 'string'
          ? JSON.parse(request.metadata)
          : request.metadata;

        // Check expiry
        if (request.download_expires_at && new Date(request.download_expires_at) < new Date()) {
          return res.status(410).json({ error: 'Export has expired. Please request a new one.' });
        }

        res.json({
          id: request.id,
          status: request.status,
          completed_at: request.completed_at,
          expires_at: request.download_expires_at,
          data: metadata.data,
        });
      } else {
        res.json({
          id: request.id,
          status: request.status,
        });
      }
    } catch (error: any) {
      logger.error('[GDPR] Get export failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // POST /delete - Request account deletion
  router.post('/delete', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const { confirmation } = req.body;
      if (confirmation !== 'DELETE MY ACCOUNT') {
        return res.status(400).json({
          error: 'Confirmation required',
          message: 'Send { "confirmation": "DELETE MY ACCOUNT" } to proceed.',
        });
      }

      const request = await gdprService.requestDeletion(userId);
      res.status(202).json({
        id: request.id,
        status: request.status,
        message: 'Account deletion initiated. All data will be removed within 24 hours.',
      });
    } catch (error: any) {
      logger.error('[GDPR] Deletion request failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // GET /requests - List GDPR requests
  router.get('/requests', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const requests = await gdprService.listRequests(userId);
      res.json({ requests });
    } catch (error: any) {
      logger.error('[GDPR] List requests failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  return router;
}
