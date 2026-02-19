import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.js';
import { AuthenticatedRequest as DualAuthRequest } from '../middleware/dual-auth.js';
import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';

export function createRestAPIRouter(db: Database): Router {
  const router = Router();

  // ==================== DOCUMENTS ====================

  // List documents with pagination (user sees own + public)
  router.get('/', (async (req: DualAuthRequest, res: Response) => {
    try {
      const userId = req.user?.id;
      const start = parseInt(req.query._start as string) || 0;
      const end = parseInt(req.query._end as string) || 10;
      const limit = end - start;
      const offset = start;

      const userFilter = userId
        ? { where: 'WHERE (user_id = $1 OR user_id IS NULL)', params: [userId] }
        : { where: '', params: [] };

      const countResult = await db.query(
        `SELECT COUNT(*) FROM documents ${userFilter.where}`,
        userFilter.params
      );
      const total = parseInt(countResult.rows[0].count);

      const paramOffset = userFilter.params.length;
      const result = await db.query(
        `SELECT id, zakononline_id, type, title, date, user_id,
                CASE WHEN full_text IS NOT NULL THEN true ELSE false END as has_full_text,
                CASE WHEN full_text_html IS NOT NULL THEN true ELSE false END as has_html,
                metadata, created_at, updated_at
         FROM documents
         ${userFilter.where}
         ORDER BY date DESC
         LIMIT $${paramOffset + 1} OFFSET $${paramOffset + 2}`,
        [...userFilter.params, limit, offset]
      );

      res.setHeader('X-Total-Count', total.toString());
      res.setHeader('Access-Control-Expose-Headers', 'X-Total-Count');
      res.json(result.rows);
    } catch (error: any) {
      logger.error('Error listing documents:', error);
      res.status(500).json({ error: 'Failed to list documents', message: error.message });
    }
  }) as any);

  // Get single document (user sees own + public)
  router.get('/:id', (async (req: DualAuthRequest, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const userId = req.user?.id;

      const result = userId
        ? await db.query(
            'SELECT * FROM documents WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)',
            [id, userId]
          )
        : await db.query('SELECT * FROM documents WHERE id = $1', [id]);

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      res.json(result.rows[0]);
    } catch (error: any) {
      logger.error('Error getting document:', error);
      res.status(500).json({ error: 'Failed to get document', message: error.message });
    }
  }) as any);

  // Create document (assign to current user)
  router.post('/', (async (req: DualAuthRequest, res: Response) => {
    try {
      const userId = req.user?.id;
      const { zakononline_id, type, title, date, full_text, full_text_html, metadata } = req.body;

      const result = await db.query(
        `INSERT INTO documents (zakononline_id, type, title, date, full_text, full_text_html, metadata, user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [zakononline_id, type, title, date, full_text, full_text_html, metadata || {}, userId || null]
      );

      res.status(201).json(result.rows[0]);
    } catch (error: any) {
      logger.error('Error creating document:', error);
      res.status(500).json({ error: 'Failed to create document', message: error.message });
    }
  }) as any);

  // Update document (only own documents)
  router.patch('/:id', (async (req: DualAuthRequest, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const userId = req.user?.id;
      const updates = req.body;

      const fields = Object.keys(updates).filter(k => k !== 'id' && k !== 'user_id');
      const setClause = fields.map((field, idx) => `${field} = $${idx + 2}`).join(', ');
      const values = [id, ...fields.map(f => updates[f])];

      if (fields.length === 0) {
        res.status(400).json({ error: 'No fields to update' });
        return;
      }

      // Only allow updating own documents (or public if no userId)
      const ownerCheck = userId ? ` AND (user_id = '${userId}' OR user_id IS NULL)` : '';
      const result = await db.query(
        `UPDATE documents SET ${setClause}, updated_at = NOW() WHERE id = $1${ownerCheck} RETURNING *`,
        values
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      res.json(result.rows[0]);
    } catch (error: any) {
      logger.error('Error updating document:', error);
      res.status(500).json({ error: 'Failed to update document', message: error.message });
    }
  }) as any);

  // Delete document (only own documents)
  router.delete('/:id', (async (req: DualAuthRequest, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const userId = req.user?.id;

      // Only allow deleting own documents
      const result = userId
        ? await db.query('DELETE FROM documents WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId])
        : await db.query('DELETE FROM documents WHERE id = $1 RETURNING id', [id]);

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      res.json(result.rows[0]);
    } catch (error: any) {
      logger.error('Error deleting document:', error);
      res.status(500).json({ error: 'Failed to delete document', message: error.message });
    }
  }) as any);

  // ==================== LEGAL PATTERNS ====================

  // List patterns
  router.get('/', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const start = parseInt(req.query._start as string) || 0;
      const end = parseInt(req.query._end as string) || 10;
      const limit = end - start;
      const offset = start;

      const countResult = await db.query('SELECT COUNT(*) FROM legal_patterns');
      const total = parseInt(countResult.rows[0].count);

      const result = await db.query(
        `SELECT * FROM legal_patterns
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      res.setHeader('X-Total-Count', total.toString());
      res.setHeader('Access-Control-Expose-Headers', 'X-Total-Count');
      res.json(result.rows);
    } catch (error: any) {
      logger.error('Error listing patterns:', error);
      res.status(500).json({ error: 'Failed to list patterns', message: error.message });
    }
  });

  // Get single pattern
  router.get('/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const result = await db.query(
        'SELECT * FROM legal_patterns WHERE id = $1',
        [id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Pattern not found' });
        return;
      }

      res.json(result.rows[0]);
    } catch (error: any) {
      logger.error('Error getting pattern:', error);
      res.status(500).json({ error: 'Failed to get pattern', message: error.message });
    }
  });

  // Create pattern
  router.post('/', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const {
        intent,
        law_articles,
        decision_outcome,
        frequency,
        confidence,
        example_cases,
        risk_factors,
        success_arguments,
        anti_patterns
      } = req.body;

      const result = await db.query(
        `INSERT INTO legal_patterns
         (intent, law_articles, decision_outcome, frequency, confidence,
          example_cases, risk_factors, success_arguments, anti_patterns)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          intent,
          law_articles || [],
          decision_outcome,
          frequency || 0,
          confidence || 0.0,
          example_cases || [],
          risk_factors || [],
          success_arguments || [],
          anti_patterns || []
        ]
      );

      res.status(201).json(result.rows[0]);
    } catch (error: any) {
      logger.error('Error creating pattern:', error);
      res.status(500).json({ error: 'Failed to create pattern', message: error.message });
    }
  });

  // Update pattern
  router.patch('/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const updates = req.body;

      const fields = Object.keys(updates).filter(k => k !== 'id');
      const setClause = fields.map((field, idx) => `${field} = $${idx + 2}`).join(', ');
      const values = [id, ...fields.map(f => updates[f])];

      if (fields.length === 0) {
        res.status(400).json({ error: 'No fields to update' });
        return;
      }

      const result = await db.query(
        `UPDATE legal_patterns SET ${setClause}, updated_at = NOW() WHERE id = $1 RETURNING *`,
        values
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Pattern not found' });
        return;
      }

      res.json(result.rows[0]);
    } catch (error: any) {
      logger.error('Error updating pattern:', error);
      res.status(500).json({ error: 'Failed to update pattern', message: error.message });
    }
  });

  // Delete pattern
  router.delete('/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const result = await db.query(
        'DELETE FROM legal_patterns WHERE id = $1 RETURNING id',
        [id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Pattern not found' });
        return;
      }

      res.json(result.rows[0]);
    } catch (error: any) {
      logger.error('Error deleting pattern:', error);
      res.status(500).json({ error: 'Failed to delete pattern', message: error.message });
    }
  });

  // ==================== QUERIES (Read-only for now) ====================

  // List queries from events table
  router.get('/', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const start = parseInt(req.query._start as string) || 0;
      const end = parseInt(req.query._end as string) || 10;
      const limit = end - start;
      const offset = start;

      const countResult = await db.query(
        "SELECT COUNT(*) FROM events WHERE event_type LIKE 'query%'"
      );
      const total = parseInt(countResult.rows[0].count);

      const result = await db.query(
        `SELECT id, event_type, payload, created_at
         FROM events
         WHERE event_type LIKE 'query%'
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      res.setHeader('X-Total-Count', total.toString());
      res.setHeader('Access-Control-Expose-Headers', 'X-Total-Count');
      res.json(result.rows);
    } catch (error: any) {
      logger.error('Error listing queries:', error);
      res.status(500).json({ error: 'Failed to list queries', message: error.message });
    }
  });

  // Get single query
  router.get('/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const result = await db.query(
        'SELECT * FROM events WHERE id = $1',
        [id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Query not found' });
        return;
      }

      res.json(result.rows[0]);
    } catch (error: any) {
      logger.error('Error getting query:', error);
      res.status(500).json({ error: 'Failed to get query', message: error.message });
    }
  });

  return router;
}
