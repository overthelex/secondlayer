import { Router, Response } from 'express';
import { AuthenticatedRequest as DualAuthRequest } from '../middleware/dual-auth.js';
import { MatterService } from '../services/matter-service.js';
import { ConflictCheckService } from '../services/conflict-check-service.js';
import { LegalHoldService } from '../services/legal-hold-service.js';
import { AuditService } from '../services/audit-service.js';
import { logger } from '../utils/logger.js';

export function createMatterRoutes(
  matterService: MatterService,
  conflictCheckService: ConflictCheckService,
  legalHoldService: LegalHoldService,
  auditService: AuditService
): Router {
  const router = Router();

  // ─── Clients ─────────────────────────────────────────────

  // POST /clients — create client
  router.post('/clients', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const orgId = await matterService.getUserOrgId(userId);
      if (!orgId) return res.status(400).json({ error: 'User is not part of an organization' });

      const { clientName, clientType, contactEmail, taxId, metadata } = req.body;
      if (!clientName) return res.status(400).json({ error: 'clientName is required' });

      const client = await matterService.createClient(orgId, {
        clientName, clientType, contactEmail, taxId, metadata,
      }, userId);

      res.status(201).json(client);
    } catch (error: any) {
      logger.error('[MatterRoutes] Create client failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // GET /clients — list clients
  router.get('/clients', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const orgId = await matterService.getUserOrgId(userId);
      if (!orgId) return res.status(400).json({ error: 'User is not part of an organization' });

      const result = await matterService.listClients(orgId, {
        status: req.query.status as string,
        search: req.query.search as string,
        limit: parseInt(req.query.limit as string) || undefined,
        offset: parseInt(req.query.offset as string) || undefined,
      });

      res.json(result);
    } catch (error: any) {
      logger.error('[MatterRoutes] List clients failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // GET /clients/:clientId — get client details
  router.get('/clients/:clientId', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const orgId = await matterService.getUserOrgId(userId);
      if (!orgId) return res.status(400).json({ error: 'User is not part of an organization' });

      const client = await matterService.getClient(req.params.clientId as string, orgId);
      if (!client) return res.status(404).json({ error: 'Client not found' });

      res.json(client);
    } catch (error: any) {
      logger.error('[MatterRoutes] Get client failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // PUT /clients/:clientId — update client
  router.put('/clients/:clientId', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const updated = await matterService.updateClient(req.params.clientId as string, req.body, userId);
      if (!updated) return res.status(404).json({ error: 'Client not found or no changes' });

      res.json(updated);
    } catch (error: any) {
      logger.error('[MatterRoutes] Update client failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // POST /clients/:clientId/conflict-check — run conflict check
  router.post('/clients/:clientId/conflict-check', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const result = await conflictCheckService.runFullConflictCheck(req.params.clientId as string, userId);
      res.json(result);
    } catch (error: any) {
      logger.error('[MatterRoutes] Conflict check failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // ─── Matters ─────────────────────────────────────────────

  // POST /matters — create matter
  router.post('/matters', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const { clientId, matterName, matterType, responsibleAttorney, opposingParty,
              courtCaseNumber, courtName, relatedParties, retentionPeriodYears, metadata } = req.body;

      if (!clientId || !matterName) {
        return res.status(400).json({ error: 'clientId and matterName are required' });
      }

      const matter = await matterService.createMatter({
        clientId, matterName, matterType, responsibleAttorney, opposingParty,
        courtCaseNumber, courtName, relatedParties, retentionPeriodYears, metadata,
      }, userId);

      res.status(201).json(matter);
    } catch (error: any) {
      logger.error('[MatterRoutes] Create matter failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // GET /matters — list matters (filtered by user access)
  router.get('/matters', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const orgId = await matterService.getUserOrgId(userId);
      if (!orgId) return res.status(400).json({ error: 'User is not part of an organization' });

      const result = await matterService.listMatters(orgId, userId, {
        status: req.query.status as string,
        clientId: req.query.clientId as string,
        search: req.query.search as string,
        limit: parseInt(req.query.limit as string) || undefined,
        offset: parseInt(req.query.offset as string) || undefined,
      });

      res.json(result);
    } catch (error: any) {
      logger.error('[MatterRoutes] List matters failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // GET /matters/:matterId — get matter details
  router.get('/matters/:matterId', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const matter = await matterService.getMatter(req.params.matterId as string, userId);
      if (!matter) return res.status(404).json({ error: 'Matter not found or access denied' });

      res.json(matter);
    } catch (error: any) {
      logger.error('[MatterRoutes] Get matter failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // PUT /matters/:matterId — update matter
  router.put('/matters/:matterId', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const updated = await matterService.updateMatter(req.params.matterId as string, req.body, userId);
      if (!updated) return res.status(404).json({ error: 'Matter not found or no changes' });

      res.json(updated);
    } catch (error: any) {
      logger.error('[MatterRoutes] Update matter failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // POST /matters/:matterId/close — close matter
  router.post('/matters/:matterId/close', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const matter = await matterService.closeMatter(req.params.matterId as string, userId);
      if (!matter) return res.status(404).json({ error: 'Matter not found' });

      res.json(matter);
    } catch (error: any) {
      logger.error('[MatterRoutes] Close matter failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // ─── Team ────────────────────────────────────────────────

  // GET /matters/:matterId/team — list team members
  router.get('/matters/:matterId/team', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const members = await matterService.getTeamMembers(req.params.matterId as string);
      res.json({ members });
    } catch (error: any) {
      logger.error('[MatterRoutes] List team failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // POST /matters/:matterId/team — add team member
  router.post('/matters/:matterId/team', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const { memberId, role, accessLevel } = req.body;
      if (!memberId) return res.status(400).json({ error: 'memberId is required' });

      const member = await matterService.addTeamMember(
        req.params.matterId as string, memberId, role || 'associate', accessLevel || 'full', userId
      );

      res.status(201).json(member);
    } catch (error: any) {
      logger.error('[MatterRoutes] Add team member failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // DELETE /matters/:matterId/team/:userId — remove team member
  router.delete('/matters/:matterId/team/:userId', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const currentUserId = req.user?.id;
      if (!currentUserId) return res.status(401).json({ error: 'User not authenticated' });

      const removed = await matterService.removeTeamMember(
        req.params.matterId as string, req.params.userId as string, currentUserId
      );

      if (!removed) return res.status(404).json({ error: 'Team member not found' });
      res.json({ success: true });
    } catch (error: any) {
      logger.error('[MatterRoutes] Remove team member failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // ─── Legal Holds ─────────────────────────────────────────

  // POST /matters/:matterId/holds — create hold
  router.post('/matters/:matterId/holds', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const { holdName, holdType, scopeDescription, custodians } = req.body;
      if (!holdName) return res.status(400).json({ error: 'holdName is required' });

      const hold = await legalHoldService.createHold({
        matterId: req.params.matterId as string,
        holdName, holdType, scopeDescription, custodians,
      }, userId);

      res.status(201).json(hold);
    } catch (error: any) {
      logger.error('[MatterRoutes] Create hold failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // GET /matters/:matterId/holds — list holds
  router.get('/matters/:matterId/holds', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const holds = await legalHoldService.listHolds(req.params.matterId as string);
      res.json({ holds });
    } catch (error: any) {
      logger.error('[MatterRoutes] List holds failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // POST /holds/:holdId/release — release hold
  router.post('/holds/:holdId/release', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const hold = await legalHoldService.releaseHold(req.params.holdId as string, userId);
      if (!hold) return res.status(404).json({ error: 'Hold not found or already released' });

      res.json(hold);
    } catch (error: any) {
      logger.error('[MatterRoutes] Release hold failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // POST /holds/:holdId/documents — add documents to hold
  router.post('/holds/:holdId/documents', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const { documentIds } = req.body;
      if (!Array.isArray(documentIds) || documentIds.length === 0) {
        return res.status(400).json({ error: 'documentIds array is required' });
      }

      const added = await legalHoldService.addDocumentsToHold(req.params.holdId as string, documentIds, userId);
      res.json({ added });
    } catch (error: any) {
      logger.error('[MatterRoutes] Add docs to hold failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // ─── Audit ───────────────────────────────────────────────

  // GET /audit — view audit log
  router.get('/audit', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const result = await auditService.getAuditLog({
        userId: req.query.userId as string,
        action: req.query.action as string,
        resourceType: req.query.resourceType as string,
        resourceId: req.query.resourceId as string,
        dateFrom: req.query.dateFrom as string,
        dateTo: req.query.dateTo as string,
        limit: parseInt(req.query.limit as string) || undefined,
        offset: parseInt(req.query.offset as string) || undefined,
      });

      res.json(result);
    } catch (error: any) {
      logger.error('[MatterRoutes] Get audit log failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // GET /audit/validate — validate chain integrity
  router.get('/audit/validate', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const result = await auditService.validateChain();
      res.json(result);
    } catch (error: any) {
      logger.error('[MatterRoutes] Validate audit chain failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  return router;
}
