import { Router, Response } from 'express';
import { AuthenticatedRequest as DualAuthRequest } from '../middleware/dual-auth.js';
import { TimeEntryService } from '../services/time-entry-service.js';
import { logger } from '../utils/logger.js';

export function createTimeEntryRoutes(timeEntryService: TimeEntryService): Router {
  const router = Router();

  // ─── Time Entries ─────────────────────────────────────────────

  // POST /entries — create time entry
  router.post('/entries', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const { matter_id, user_id, entry_date, duration_minutes, description, billable, notes } = req.body;

      if (!matter_id || !duration_minutes || !description) {
        return res.status(400).json({ error: 'matter_id, duration_minutes, and description are required' });
      }

      const entry = await timeEntryService.createEntry({
        matter_id,
        user_id: user_id || userId, // Default to current user
        entry_date,
        duration_minutes: parseInt(duration_minutes),
        description,
        billable,
        notes,
        created_by: userId
      });

      res.status(201).json(entry);
    } catch (error: any) {
      logger.error('[TimeEntryRoutes] Create entry failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // GET /entries — list time entries
  router.get('/entries', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const result = await timeEntryService.listEntries({
        matter_id: req.query.matter_id as string,
        user_id: req.query.user_id as string,
        status: req.query.status as string,
        billable: req.query.billable === 'true' ? true : req.query.billable === 'false' ? false : undefined,
        date_from: req.query.date_from as string,
        date_to: req.query.date_to as string,
        limit: parseInt(req.query.limit as string) || undefined,
        offset: parseInt(req.query.offset as string) || undefined,
      });

      res.json(result);
    } catch (error: any) {
      logger.error('[TimeEntryRoutes] List entries failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // PUT /entries/:entryId — update time entry
  router.put('/entries/:entryId', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const { entry_date, duration_minutes, description, billable, notes } = req.body;

      const entry = await timeEntryService.updateEntry(
        String(req.params.entryId),
        {
          entry_date,
          duration_minutes: duration_minutes ? parseInt(duration_minutes) : undefined,
          description,
          billable,
          notes
        },
        userId
      );

      res.json(entry);
    } catch (error: any) {
      logger.error('[TimeEntryRoutes] Update entry failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // DELETE /entries/:entryId — delete time entry
  router.delete('/entries/:entryId', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      await timeEntryService.deleteEntry(String(req.params.entryId), userId);

      res.status(204).send();
    } catch (error: any) {
      logger.error('[TimeEntryRoutes] Delete entry failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // POST /entries/:entryId/submit — submit for approval
  router.post('/entries/:entryId/submit', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const entry = await timeEntryService.submitForApproval(String(req.params.entryId), userId);

      res.json(entry);
    } catch (error: any) {
      logger.error('[TimeEntryRoutes] Submit entry failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // POST /entries/:entryId/approve — approve time entry
  router.post('/entries/:entryId/approve', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const entry = await timeEntryService.approveEntry(String(req.params.entryId), userId);

      res.json(entry);
    } catch (error: any) {
      logger.error('[TimeEntryRoutes] Approve entry failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // POST /entries/:entryId/reject — reject time entry
  router.post('/entries/:entryId/reject', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const { notes } = req.body;

      const entry = await timeEntryService.rejectEntry(String(req.params.entryId), userId, notes);

      res.json(entry);
    } catch (error: any) {
      logger.error('[TimeEntryRoutes] Reject entry failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // ─── Timers ─────────────────────────────────────────────

  // POST /timers/start — start timer
  router.post('/timers/start', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const { matter_id, description } = req.body;

      if (!matter_id) {
        return res.status(400).json({ error: 'matter_id is required' });
      }

      const timer = await timeEntryService.startTimer({
        user_id: userId,
        matter_id,
        description
      });

      res.status(201).json(timer);
    } catch (error: any) {
      logger.error('[TimeEntryRoutes] Start timer failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // POST /timers/stop — stop timer
  router.post('/timers/stop', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const { matter_id, create_entry } = req.body;

      if (!matter_id) {
        return res.status(400).json({ error: 'matter_id is required' });
      }

      const result = await timeEntryService.stopTimer(
        userId,
        matter_id,
        create_entry !== false // Default true
      );

      res.json(result);
    } catch (error: any) {
      logger.error('[TimeEntryRoutes] Stop timer failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // GET /timers/active — get active timers
  router.get('/timers/active', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const timers = await timeEntryService.getActiveTimers(userId);

      res.json({ timers });
    } catch (error: any) {
      logger.error('[TimeEntryRoutes] Get active timers failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // POST /timers/ping — ping timer
  router.post('/timers/ping', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const { matter_id } = req.body;

      if (!matter_id) {
        return res.status(400).json({ error: 'matter_id is required' });
      }

      await timeEntryService.pingTimer(userId, matter_id);

      res.status(204).send();
    } catch (error: any) {
      logger.error('[TimeEntryRoutes] Ping timer failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // ─── Billing Rates ─────────────────────────────────────────────

  // GET /rates/:userId — get user's current billing rate
  router.get('/rates/:userId', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const rate = await timeEntryService.getUserRate(String(req.params.userId), req.query.date as string);

      res.json({ hourly_rate_usd: rate });
    } catch (error: any) {
      logger.error('[TimeEntryRoutes] Get user rate failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // POST /rates — set user billing rate
  router.post('/rates', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const { user_id, hourly_rate_usd, effective_from, effective_to, is_default } = req.body;

      if (!user_id || hourly_rate_usd === undefined) {
        return res.status(400).json({ error: 'user_id and hourly_rate_usd are required' });
      }

      const rate = await timeEntryService.setUserRate(
        user_id,
        parseFloat(hourly_rate_usd),
        effective_from || new Date().toISOString().split('T')[0],
        effective_to || null,
        is_default !== false, // Default true
        userId
      );

      res.status(201).json(rate);
    } catch (error: any) {
      logger.error('[TimeEntryRoutes] Set user rate failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // GET /rates/:userId/history — get rate history
  router.get('/rates/:userId/history', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const rates = await timeEntryService.getUserRateHistory(String(req.params.userId));

      res.json({ rates });
    } catch (error: any) {
      logger.error('[TimeEntryRoutes] Get rate history failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  return router;
}
