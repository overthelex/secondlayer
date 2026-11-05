/**
 * Misc Inline Routes
 * Extracted from http-server.ts — documents, legislation, history, prompts, and internal endpoints
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest as DualAuthRequest, dualAuth, requireJWT } from '../middleware/dual-auth.js';
import { createClientKeyGuard } from '../middleware/client-key-guard.js';
import { logger } from '../utils/logger.js';
import { Database } from '../database/database.js';
import { DocumentClassificationService } from '../services/document-classification-service.js';
import { VaultTools } from '../api/vault-tools.js';
import { MinioService } from '../services/minio-service.js';
import { LegislationTools } from '../api/legislation-tools.js';

export function createMiscInlineRoutes(deps: {
  db: Database;
  classificationService: DocumentClassificationService;
  vaultTools: VaultTools;
  minioService: MinioService;
  legislationTools: LegislationTools;
}): Router {
  const router = Router();

  // ============ Document endpoints ============

  // GET /documents/stats - Get user document statistics
  router.get('/documents/stats', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const stats = await deps.classificationService.getUserDocumentStats(userId);
      res.json(stats);
    } catch (error: any) {
      logger.error('Failed to get document stats', { error: error.message });
      res.status(500).json({ error: 'Failed to get stats', message: error.message });
    }
  }) as any);

  // GET /documents/folders - List document folders
  router.get('/documents/folders', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const prefix = (req.query.prefix as string) || '';
      const result = await deps.vaultTools.listFolders({ prefix, userId });
      res.json(result);
    } catch (error: any) {
      logger.error('Failed to list folders', { error: error.message });
      res.status(500).json({ error: 'Failed to list folders', message: error.message });
    }
  }) as any);

  // DELETE /documents/folders/:folderPath - Soft-delete all documents within a folder path
  router.delete('/documents/folders/:folderPath', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const folderPath = decodeURIComponent(req.params.folderPath as string);

      if (!folderPath) {
        res.status(400).json({ error: 'folderPath is required' });
        return;
      }

      const result = await deps.db.query(
        `UPDATE documents
         SET deleted_at = NOW()
         WHERE user_id = $1
           AND deleted_at IS NULL
           AND metadata->>'folderPath' LIKE $2`,
        [userId, folderPath + '%']
      );

      res.json({ deleted: result.rowCount || 0 });
    } catch (error: any) {
      logger.error('Failed to delete folder', { error: error.message, folderPath: req.params.folderPath });
      res.status(500).json({ error: 'Failed to delete folder', message: error.message });
    }
  }) as any);

  // GET /documents/:id/preview - Get presigned MinIO URL for binary files
  router.get('/documents/:id/preview', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const { id } = req.params;

      const result = await deps.db.query(
        'SELECT storage_type, storage_path, mime_type, metadata FROM documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
        [id, userId]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      const doc = result.rows[0];

      if (doc.storage_type === 'minio' && doc.metadata?.minioKey) {
        const isPreviewable = doc.mime_type === 'application/pdf' || doc.mime_type?.startsWith('image/') || doc.mime_type?.startsWith('video/') || !!doc.metadata?.previewKey;
        const bucket = doc.metadata?.minioBucket || `user-${userId}`;

        // For documents with a previewKey (JPG thumbnail from PDF/DOCX), serve that instead
        let previewUrl: string;
        let previewMime = doc.mime_type;
        if (doc.metadata?.previewKey) {
          previewUrl = await deps.minioService.getFileUrlFromBucket(bucket, doc.metadata.previewKey, 3600, true);
          previewMime = 'image/jpeg';
        } else {
          previewUrl = await deps.minioService.getFileUrlFromBucket(bucket, doc.metadata.minioKey, 3600, isPreviewable);
        }

        res.json({ previewUrl, mimeType: previewMime, storageType: 'minio' });
      } else {
        // Vault document — no binary preview, content is text
        res.json({ previewUrl: null, mimeType: doc.mime_type, storageType: doc.storage_type || 'vault' });
      }
    } catch (error: any) {
      logger.error('Failed to get document preview', { error: error.message });
      res.status(500).json({ error: 'Failed to get preview', message: error.message });
    }
  }) as any);

  // POST /documents/:id/move - Update folderPath via jsonb_set
  router.post('/documents/:id/move', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const { id } = req.params;
      const { folderPath } = req.body;

      if (folderPath === undefined) {
        res.status(400).json({ error: 'folderPath is required' });
        return;
      }

      const sanitized = typeof folderPath === 'string' ? folderPath : '';
      const result = await deps.db.query(
        `UPDATE documents
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{folderPath}', $3::jsonb),
             updated_at = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING id, title, metadata`,
        [id, userId, JSON.stringify(sanitized)]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      res.json(result.rows[0]);
    } catch (error: any) {
      logger.error('Failed to move document', { error: error.message });
      res.status(500).json({ error: 'Failed to move document', message: error.message });
    }
  }) as any);

  // ============ Legislation endpoints ============

  // GET /legislation/stats - Get legislation statistics (MUST be before /:radaId routes)
  router.get('/legislation/stats', requireJWT as any, (async (_req: DualAuthRequest, res: Response) => {
    try {
      const legislationService = deps.legislationTools.getLegislationService();
      const stats = await legislationService.getLegislationStats();
      res.json(stats);
    } catch (error: any) {
      logger.error('Error getting legislation stats:', error.message);
      res.status(500).json({ error: 'Failed to get legislation stats' });
    }
  }) as any);

  // GET /legislation/types - Get distinct legislation types (MUST be before /:radaId routes)
  router.get('/legislation/types', requireJWT as any, (async (_req: DualAuthRequest, res: Response) => {
    try {
      const legislationService = deps.legislationTools.getLegislationService();
      const types = await legislationService.getDistinctTypes();
      res.json({ types });
    } catch (error: any) {
      logger.error('Error getting legislation types:', error.message);
      res.status(500).json({ error: 'Failed to get legislation types' });
    }
  }) as any);

  // GET /legislation - List legislation
  router.get('/legislation', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const offset = parseInt(req.query.offset as string) || 0;
      const search = (req.query.search as string) || undefined;

      const filters: { type?: string; status?: string; dateFrom?: string; dateTo?: string } = {};
      if (req.query.type) filters.type = req.query.type as string;
      if (req.query.status) filters.status = req.query.status as string;
      if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom as string;
      if (req.query.dateTo) filters.dateTo = req.query.dateTo as string;

      const legislationService = deps.legislationTools.getLegislationService();
      const result = await legislationService.listLegislation(
        limit, offset, search,
        Object.keys(filters).length > 0 ? filters : undefined
      );

      res.json(result);
    } catch (error: any) {
      logger.error('Error listing legislation:', error.message);
      res.status(500).json({ error: 'Failed to list legislation' });
    }
  }) as any);

  // GET /legislation/:radaId/history - Get amendment history
  router.get('/legislation/:radaId/history', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
    try {
      const radaId = req.params.radaId as string;
      const legislationService = deps.legislationTools.getLegislationService();
      const history = await legislationService.getAmendmentHistory(radaId);
      res.json({ history });
    } catch (error: any) {
      logger.error('Error getting legislation history:', error.message);
      res.status(500).json({ error: 'Failed to get legislation history' });
    }
  }) as any);

  // GET /legislation/:radaId/structure - Get legislation structure
  router.get('/legislation/:radaId/structure', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
    try {
      const radaId = req.params.radaId as string;
      const legislationService = deps.legislationTools.getLegislationService();
      const structure = await legislationService.getLegislationStructure(radaId);

      if (!structure) {
        return res.status(404).json({ error: 'Legislation not found' });
      }

      res.json(structure);
    } catch (error: any) {
      logger.error('Error getting legislation structure:', error.message);
      res.status(500).json({ error: 'Failed to get legislation structure' });
    }
  }) as any);

  // GET /legislation/:radaId/article/:articleNumber - Get specific article
  router.get('/legislation/:radaId/article/:articleNumber', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
    try {
      const radaId = req.params.radaId as string;
      const articleNumber = req.params.articleNumber as string;
      const legislationService = deps.legislationTools.getLegislationService();
      const article = await legislationService.getArticle(radaId, articleNumber);

      if (!article) {
        return res.status(404).json({ error: 'Article not found' });
      }

      res.json(article);
    } catch (error: any) {
      logger.error('Error getting legislation article:', error.message);
      res.status(500).json({ error: 'Failed to get article' });
    }
  }) as any);

  // ============ History endpoint ============

  // GET /history - Query history from cost_tracking
  router.get('/history', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      // Get user's query history from cost_tracking (filtered by user_id)
      const result = await deps.db.query(
        `SELECT
          id,
          request_id,
          tool_name,
          user_query,
          query_params,
          status,
          created_at,
          completed_at,
          execution_time_ms,
          total_cost_usd
        FROM cost_tracking
        WHERE user_id = $1
          AND status IN ('completed', 'failed')
          AND user_query IS NOT NULL
          AND user_query != ''
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );

      // Get total count
      const countResult = await deps.db.query(
        `SELECT COUNT(*)
        FROM cost_tracking
        WHERE user_id = $1
          AND status IN ('completed', 'failed')
          AND user_query IS NOT NULL
          AND user_query != ''`,
        [userId]
      );

      res.json({
        history: result.rows,
        total: parseInt(countResult.rows[0].count),
        limit,
        offset,
      });
    } catch (error: any) {
      logger.error('Error getting query history:', error);
      res.status(500).json({
        error: 'Failed to get query history',
        message: error.message,
      });
    }
  }) as any);

  // ============ User prompts (save/load) ============

  // GET /prompts - List user prompts
  router.get('/prompts', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
    try {
      const userId = req.user?.id;
      const result = await deps.db.query(
        'SELECT id, name, content, is_favorite, created_at FROM user_prompts WHERE user_id = $1 ORDER BY is_favorite DESC, created_at DESC',
        [userId]
      );
      res.json({ prompts: result.rows });
    } catch (error: any) {
      logger.error('Failed to list prompts:', error);
      res.status(500).json({ error: 'Failed to list prompts' });
    }
  }) as any);

  // POST /prompts - Save a new prompt
  router.post('/prompts', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
    try {
      const userId = req.user?.id;
      const { name, content } = req.body;
      if (!name || !content) {
        return res.status(400).json({ error: 'name and content are required' });
      }
      const result = await deps.db.query(
        'INSERT INTO user_prompts (user_id, name, content) VALUES ($1, $2, $3) RETURNING id, name, content, created_at',
        [userId, name.trim(), content.trim()]
      );
      res.status(201).json({ prompt: result.rows[0] });
    } catch (error: any) {
      logger.error('Failed to save prompt:', error);
      res.status(500).json({ error: 'Failed to save prompt' });
    }
  }) as any);

  // PATCH /prompts/:id/favorite - Toggle favorite
  router.patch('/prompts/:id/favorite', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
    try {
      const userId = req.user?.id;
      const { id } = req.params;
      const result = await deps.db.query(
        'UPDATE user_prompts SET is_favorite = NOT is_favorite WHERE id = $1 AND user_id = $2 RETURNING id, is_favorite',
        [id, userId]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Prompt not found' });
      }
      res.json({ prompt: result.rows[0] });
    } catch (error: any) {
      logger.error('Failed to toggle favorite:', error);
      res.status(500).json({ error: 'Failed to toggle favorite' });
    }
  }) as any);

  // DELETE /prompts/:id - Delete a prompt
  router.delete('/prompts/:id', requireJWT as any, (async (req: DualAuthRequest, res: Response) => {
    try {
      const userId = req.user?.id;
      const { id } = req.params;
      const result = await deps.db.query(
        'DELETE FROM user_prompts WHERE id = $1 AND user_id = $2 RETURNING id',
        [id, userId]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Prompt not found' });
      }
      res.json({ success: true });
    } catch (error: any) {
      logger.error('Failed to delete prompt:', error);
      res.status(500).json({ error: 'Failed to delete prompt' });
    }
  }) as any);

  // ============ Internal endpoints (dualAuth: JWT, admin key or legacy env key; client keys refused) ============
  const clientKeyGuard = createClientKeyGuard(deps.db as any) as any;

  // GET /internal/db-stats - Internal service-to-service endpoint for DB stats
  router.get('/internal/db-stats', dualAuth as any, clientKeyGuard, (async (_req: DualAuthRequest, res: Response) => {
    const tableList = [
      'documents', 'document_sections', 'legislation', 'legislation_articles',
      'legislation_chunks', 'users', 'conversations', 'upload_sessions', 'zo_dictionaries',
    ];
    const openreyestrUrl = process.env.OPENREYESTR_MCP_URL || 'http://openreyestr-app-local:3004';
    const openreyestrKey = process.env.OPENREYESTR_API_KEY || 'test-key-123';
    const radaUrl = process.env.RADA_MCP_URL || 'http://rada-mcp-app-local:3001';
    const radaKey = process.env.RADA_API_KEY || 'test-key-123';

    async function fetchServiceStats(baseUrl: string, apiKey: string) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        const resp = await fetch(`${baseUrl}/api/stats`, {
          headers: { 'x-api-key': apiKey },
          signal: controller.signal,
        });
        clearTimeout(timer);
        return await resp.json();
      } catch {
        return null;
      }
    }

    try {
      const mainTables: Record<string, number> = {};
      for (const t of tableList) {
        try {
          const r = await deps.db.query(`SELECT COUNT(*) as cnt FROM ${t}`);
          mainTables[t] = parseInt(r.rows[0]?.cnt || '0');
        } catch {
          mainTables[t] = -1;
        }
      }
      const [openreyestrStats, radaStats] = await Promise.all([
        fetchServiceStats(openreyestrUrl, openreyestrKey),
        fetchServiceStats(radaUrl, radaKey),
      ]);
      res.json({
        local: {
          openreyestr: openreyestrStats,
          rada: radaStats,
          main: mainTables,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to collect db stats' });
    }
  }) as any);

  // GET /internal/edrsr-stats - Internal EDRSR stats endpoint
  router.get('/internal/edrsr-stats', dualAuth as any, clientKeyGuard, (async (_req: DualAuthRequest, res: Response) => {
    try {
      // Check if tables exist
      const tablesExist = await deps.db.query(`
        SELECT
          EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='edrsr_documents') AS has_docs,
          EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='edrsr_fulltext') AS has_ft
      `);
      const { has_docs, has_ft } = tablesExist.rows[0];

      let edrsrByYear: Array<{ year: number | null; total: number; with_fulltext: number }> = [];

      if (has_docs && has_ft) {
        const result = await deps.db.query(`
          SELECT
            EXTRACT(YEAR FROM e.adjudication_date)::int AS year,
            COUNT(*)::int AS total,
            COUNT(f.doc_id)::int AS with_fulltext
          FROM edrsr_documents e
          LEFT JOIN edrsr_fulltext f ON f.doc_id = e.doc_id
          GROUP BY year
          ORDER BY year NULLS LAST
        `);
        edrsrByYear = result.rows;
      } else if (has_docs) {
        const result = await deps.db.query(`
          SELECT
            EXTRACT(YEAR FROM adjudication_date)::int AS year,
            COUNT(*)::int AS total,
            0 AS with_fulltext
          FROM edrsr_documents
          GROUP BY year
          ORDER BY year NULLS LAST
        `);
        edrsrByYear = result.rows;
      }

      // Also get standalone fulltext records not in edrsr_documents
      let standaloneFulltext = 0;
      if (has_ft) {
        const ftOnly = await deps.db.query(`
          SELECT COUNT(*)::int AS cnt FROM edrsr_fulltext f
          WHERE NOT EXISTS (SELECT 1 FROM edrsr_documents e WHERE e.doc_id = f.doc_id)
        `);
        standaloneFulltext = ftOnly.rows[0]?.cnt || 0;
      }

      // Get total counts
      let totalDocs = 0;
      let totalFulltext = 0;
      if (has_docs) {
        const r = await deps.db.query('SELECT COUNT(*)::int AS cnt FROM edrsr_documents');
        totalDocs = r.rows[0]?.cnt || 0;
      }
      if (has_ft) {
        const r = await deps.db.query('SELECT COUNT(*)::int AS cnt FROM edrsr_fulltext');
        totalFulltext = r.rows[0]?.cnt || 0;
      }

      res.json({
        byYear: edrsrByYear,
        totalDocuments: totalDocs,
        totalFulltext: totalFulltext,
        standaloneFulltext,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      logger.error('internal/edrsr-stats failed', { error: error.message });
      res.status(500).json({ error: 'Failed to collect EDRSR stats' });
    }
  }) as any);

  return router;
}
