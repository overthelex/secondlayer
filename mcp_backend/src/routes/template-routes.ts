/**
 * Template System Routes
 *
 * REST API for the dynamic template system:
 * - Question classification
 * - Template matching and recommendations
 * - Template generation and approval workflow
 * - Usage tracking and analytics
 */

import { Router, Request, Response, NextFunction } from 'express';
import { getTemplateClassifier } from '../services/template-system';
import { AuthenticatedRequest } from '@secondlayer/shared';
import { logger } from '@secondlayer/shared';
import { BaseDatabase } from '@secondlayer/shared';

export function createTemplateRoutes(db: BaseDatabase): Router {
  const router = Router();

  // Middleware to ensure authentication
  const requireAuth = (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user?.id && !authReq.headers.authorization) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };

  const requireAdminAuth = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const authReq = req as AuthenticatedRequest;
    const user = authReq.user;

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      // Check if user has admin role in database
      const result = await db.query('SELECT is_admin FROM users WHERE id = $1', [user.id]);

      if (!result.rows[0]?.is_admin) {
        return res.status(403).json({ error: 'Forbidden: Admin access required' });
      }

      next();
    } catch (error: any) {
      logger.error('Error checking admin status', { error: error.message, userId: user.id });
      res.status(500).json({ error: 'Failed to verify admin access' });
    }
  };

  // ============================================================================
  // Classification Endpoints
  // ============================================================================

  /**
   * POST /api/templates/classify-question
   * Classify a question to determine intent and category
   */
  router.post('/classify-question', requireAuth, async (req: Request, res: Response) => {
    try {
      const { question } = req.body;
      const authReq = req as AuthenticatedRequest;

      if (!question || typeof question !== 'string') {
        return res.status(400).json({
          error: 'Invalid input: question must be a non-empty string',
        });
      }

      if (question.length < 5) {
        return res.status(400).json({
          error: 'Question too short: minimum 5 characters',
        });
      }

      const classifier = getTemplateClassifier();
      const classification = await classifier.classifyQuestion(question);

      // Extract entities
      const entities = await classifier.extractEntities(question, classification);
      classification.entities = entities;

      // Store classification in database
      await db.query(
        `INSERT INTO question_classifications
        (user_id, question_text, question_hash, classified_intent, intent_confidence, category, entities)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          authReq.user?.id || 'anonymous',
          question,
          require('crypto')
            .createHash('sha256')
            .update(question.toLowerCase())
            .digest('hex'),
          classification.intent,
          classification.confidence,
          classification.category,
          JSON.stringify(entities),
        ]
      );

      logger.info('Question classified', {
        userId: authReq.user?.id,
        intent: classification.intent,
        confidence: classification.confidence,
      });

      return res.status(200).json({
        classification,
      });
    } catch (error) {
      logger.error('Classification failed', {
        error: (error as Error).message,
      });
      return res.status(500).json({
        error: 'Classification failed',
      });
    }
  });

  /**
   * GET /api/templates/classify-question/stats
   * Get classification statistics for the given period
   */
  router.get('/classify-question/stats', async (req: Request, res: Response) => {
    try {
      const { days = 30 } = req.query;
      const daysNum = parseInt(days as string, 10) || 30;

      const result = await db.query(
        `SELECT
          COUNT(*) as total_classifications,
          COUNT(DISTINCT classified_intent) as unique_intents,
          COUNT(DISTINCT category) as unique_categories,
          AVG(intent_confidence) as avg_confidence,
          MAX(intent_confidence) as max_confidence,
          MIN(intent_confidence) as min_confidence
        FROM question_classifications
        WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '1 day' * $1`,
        [daysNum]
      );

      const stats = result.rows[0] || {
        total_classifications: 0,
        unique_intents: 0,
        unique_categories: 0,
        avg_confidence: 0,
        max_confidence: 0,
        min_confidence: 0,
      };

      // Get top intents
      const topIntents = await db.query(
        `SELECT classified_intent, COUNT(*) as count
        FROM question_classifications
        WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '1 day' * $1
        GROUP BY classified_intent
        ORDER BY count DESC
        LIMIT 10`,
        [daysNum]
      );

      // Get top categories
      const topCategories = await db.query(
        `SELECT category, COUNT(*) as count
        FROM question_classifications
        WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '1 day' * $1
        GROUP BY category
        ORDER BY count DESC
        LIMIT 10`,
        [daysNum]
      );

      return res.status(200).json({
        stats,
        topIntents: topIntents.rows,
        topCategories: topCategories.rows,
      });
    } catch (error) {
      logger.error('Stats query failed', {
        error: (error as Error).message,
      });
      return res.status(500).json({
        error: 'Failed to retrieve stats',
      });
    }
  });

  // ============================================================================
  // Template Matching Endpoints
  // ============================================================================

  /**
   * GET /api/templates/match
   * Match a classified question against existing templates
   * Note: Requires TemplateMatcher service (TBD)
   */
  router.get('/match', requireAuth, async (req: Request, res: Response) => {
    try {
      const { intent, category, confidence } = req.query;

      if (!intent || !category) {
        return res.status(400).json({
          error: 'Missing required parameters: intent, category',
        });
      }

      // Query matching templates
      const result = await db.query(
        `SELECT id, name, category, intent_keywords, quality_score, success_rate, user_satisfaction
        FROM question_templates
        WHERE status = 'active'
          AND category = $1
          AND intent_keywords @> ARRAY[$2]
        ORDER BY quality_score DESC, total_uses DESC
        LIMIT 10`,
        [category, intent]
      );

      const matches = result.rows.map((row: any) => ({
        templateId: row.id,
        templateName: row.name,
        matchScore: parseFloat((0.7 + Math.random() * 0.3).toFixed(2)), // TBD: Semantic matching
        qualityScore: row.quality_score,
        successRate: row.success_rate,
        userSatisfaction: row.user_satisfaction,
        shouldGenerateNew: false, // TBD: Check similarity threshold
      }));

      logger.info('Templates matched', {
        intent,
        category,
        matchCount: matches.length,
      });

      return res.status(200).json({
        matches,
        shouldGenerate: matches.length === 0,
      });
    } catch (error) {
      logger.error('Matching failed', {
        error: (error as Error).message,
      });
      return res.status(500).json({
        error: 'Matching failed',
      });
    }
  });

  /**
   * POST /api/templates/match/batch
   * Match multiple questions in batch
   */
  router.post('/match/batch', requireAuth, async (req: Request, res: Response) => {
    try {
      const { questions } = req.body;

      if (!Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({
          error: 'Invalid input: questions must be a non-empty array',
        });
      }

      if (questions.length > 100) {
        return res.status(400).json({
          error: 'Too many questions: maximum 100 per batch',
        });
      }

      const classifier = getTemplateClassifier();
      const results = [];

      for (const question of questions) {
        try {
          const classification = await classifier.classifyQuestion(question);
          const matches = await db.query(
            `SELECT id, name, category, quality_score
            FROM question_templates
            WHERE status = 'active' AND category = $1
            ORDER BY quality_score DESC
            LIMIT 5`,
            [classification.category]
          );

          results.push({
            question,
            classification,
            matches: matches.rows,
          });
        } catch (err) {
          logger.warn('Batch processing failed for question', {
            question: question.substring(0, 50),
          });
          results.push({
            question,
            error: 'Processing failed',
          });
        }
      }

      return res.status(200).json({
        results,
        processedCount: results.length,
      });
    } catch (error) {
      logger.error('Batch matching failed', {
        error: (error as Error).message,
      });
      return res.status(500).json({
        error: 'Batch matching failed',
      });
    }
  });

  // ============================================================================
  // Template Generation & Approval Endpoints
  // ============================================================================

  /**
   * POST /api/templates/generate
   * Generate a new template from an unmatched question
   * Note: Requires TemplateGenerator service (TBD)
   */
  router.post(
    '/generate',
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const { question, classification } = req.body;
        const authReq = req as AuthenticatedRequest;

        if (!question || !classification) {
          return res.status(400).json({
            error: 'Missing required fields: question, classification',
          });
        }

        // Get the classification ID from database
        const classificationResult = await db.query(
          `SELECT id FROM question_classifications
          WHERE question_text = $1 AND user_id = $2
          ORDER BY created_at DESC
          LIMIT 1`,
          [question, authReq.user?.id || 'anonymous']
        );

        const classificationId =
          classificationResult.rows[0]?.id ||
          '00000000-0000-0000-0000-000000000000';

        // Create generation record (TBD: Call TemplateGenerator service)
        const generationResult = await db.query(
          `INSERT INTO template_generations
          (user_id, triggering_question_id, triggering_question, generated_template, generation_model, generation_cost_usd, validation_status, approval_status, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING id, generated_template, validation_status`,
          [
            authReq.user?.id || 'anonymous',
            classificationId,
            question,
            JSON.stringify({
              name: `Template_${Date.now()}`,
              category: classification.category,
              promptTemplate: 'TBD', // Will be generated by TemplateGenerator
              inputSchema: {},
              outputSchema: {},
              instructions: '',
              exampleInput: {},
              exampleOutput: {},
              intentKeywords: [classification.intent],
            }),
            'gpt-4o',
            0.08,
            'pending',
            'pending',
            'pending',
          ]
        );

        const generationId = generationResult.rows[0]?.id;

        logger.info('Template generation initiated', {
          generationId,
          userId: authReq.user?.id,
          category: classification.category,
        });

        return res.status(201).json({
          generationId,
          status: 'pending',
          message: 'Template generation started. Awaiting validation and admin review.',
        });
      } catch (error) {
        logger.error('Generation failed', {
          error: (error as Error).message,
        });
        return res.status(500).json({
          error: 'Generation failed',
        });
      }
    }
  );

  /**
   * GET /api/templates/generation/:id/status
   * Check status of template generation
   */
  router.get('/generation/:id/status', requireAuth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const result = await db.query(
        `SELECT id, status, approval_status, validation_status, generated_template,
                validation_errors, test_results, admin_feedback, rollout_percentage
        FROM template_generations
        WHERE id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Generation not found',
        });
      }

      const generation = result.rows[0];

      return res.status(200).json({
        generationId: generation.id,
        status: generation.status,
        approvalStatus: generation.approval_status,
        validationStatus: generation.validation_status,
        template: JSON.parse(generation.generated_template),
        validationErrors: generation.validation_errors,
        testResults: generation.test_results,
        adminFeedback: generation.admin_feedback,
        rolloutPercentage: generation.rollout_percentage,
      });
    } catch (error) {
      logger.error('Status query failed', {
        error: (error as Error).message,
      });
      return res.status(500).json({
        error: 'Failed to retrieve status',
      });
    }
  });

  /**
   * PUT /api/templates/generation/:id/approve
   * Approve a generated template (admin only)
   */
  router.put(
    '/generation/:id/approve',
    requireAdminAuth,
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const { approvalNotes, suggestedImprovements } = req.body;
        const authReq = req as AuthenticatedRequest;

        const result = await db.query(
          `UPDATE template_generations
          SET approval_status = 'approved',
              approved_by = $1,
              approval_notes = $2,
              suggested_improvements = $3,
              approved_at = CURRENT_TIMESTAMP,
              status = 'approved'
          WHERE id = $4
          RETURNING id, generated_template`,
          [authReq.user?.id, approvalNotes, suggestedImprovements, id]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({
            error: 'Generation not found',
          });
        }

        const generation = result.rows[0];

        // TBD: Call TemplateStorage to save approved template
        logger.info('Template approved', {
          generationId: id,
          approvedBy: authReq.user?.id,
        });

        return res.status(200).json({
          generationId: id,
          status: 'approved',
          message: 'Template approved and ready for rollout',
        });
      } catch (error) {
        logger.error('Approval failed', {
          error: (error as Error).message,
        });
        return res.status(500).json({
          error: 'Approval failed',
        });
      }
    }
  );

  /**
   * PUT /api/templates/generation/:id/reject
   * Reject a generated template (admin only)
   */
  router.put(
    '/generation/:id/reject',
    requireAdminAuth,
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const { reason, feedback } = req.body;

        await db.query(
          `UPDATE template_generations
          SET approval_status = 'rejected',
              admin_feedback = $1,
              status = 'rejected'
          WHERE id = $2`,
          [feedback || reason, id]
        );

        logger.info('Template rejected', {
          generationId: id,
          reason,
        });

        return res.status(200).json({
          generationId: id,
          status: 'rejected',
          message: 'Template rejected',
        });
      } catch (error) {
        logger.error('Rejection failed', {
          error: (error as Error).message,
        });
        return res.status(500).json({
          error: 'Rejection failed',
        });
      }
    }
  );

  // ============================================================================
  // Template Management Endpoints
  // ============================================================================

  /**
   * GET /api/templates
   * List all templates with optional filtering
   */
  router.get('/list', async (req: Request, res: Response) => {
    try {
      const { category, status = 'active', limit = 50, offset = 0 } = req.query;
      const limitNum = Math.min(parseInt(limit as string, 10) || 50, 500);
      const offsetNum = parseInt(offset as string, 10) || 0;

      let query = `SELECT id, name, category, status, current_version, quality_score,
                          success_rate, user_satisfaction, total_uses, created_at
                  FROM question_templates
                  WHERE status = $1`;
      const params: any[] = [status];

      if (category) {
        query += ` AND category = $${params.length + 1}`;
        params.push(category);
      }

      query += ` ORDER BY quality_score DESC, total_uses DESC
                 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limitNum, offsetNum);

      const result = await db.query(query, params);

      // Get total count
      let countQuery = 'SELECT COUNT(*) FROM question_templates WHERE status = $1';
      const countParams: any[] = [status];
      if (category) {
        countQuery += ` AND category = $${countParams.length + 1}`;
        countParams.push(category);
      }
      const countResult = await db.query(countQuery, countParams);
      const total = parseInt(countResult.rows[0]?.count || '0', 10);

      return res.status(200).json({
        templates: result.rows,
        total,
        limit: limitNum,
        offset: offsetNum,
        hasMore: offsetNum + limitNum < total,
      });
    } catch (error) {
      logger.error('Template list failed', {
        error: (error as Error).message,
      });
      return res.status(500).json({
        error: 'Failed to retrieve templates',
      });
    }
  });

  /**
   * GET /api/templates/:id
   * Get detailed information about a specific template
   */
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const templateResult = await db.query(
        `SELECT id, name, category, intent_keywords, prompt_template, input_schema, output_schema,
                description, instructions, example_input, example_output, status, current_version,
                quality_score, success_rate, user_satisfaction, total_uses, generation_cost_usd,
                avg_execution_cost_usd, created_at, updated_at, deprecated_at
        FROM question_templates
        WHERE id = $1`,
        [id]
      );

      if (templateResult.rows.length === 0) {
        return res.status(404).json({
          error: 'Template not found',
        });
      }

      const template = templateResult.rows[0];

      // Get versions
      const versionsResult = await db.query(
        `SELECT version_number, change_type, change_description, released_at, is_current, is_supported
        FROM template_versions
        WHERE template_id = $1
        ORDER BY released_at DESC`,
        [id]
      );

      // Get feedback
      const feedbackResult = await db.query(
        `SELECT AVG(rating) as avg_rating, COUNT(*) as total_feedback,
                SUM(CASE WHEN was_helpful THEN 1 ELSE 0 END) as helpful_count
        FROM template_feedback
        WHERE template_id = $1`,
        [id]
      );

      const feedback = feedbackResult.rows[0];

      return res.status(200).json({
        template,
        versions: versionsResult.rows,
        feedback,
      });
    } catch (error) {
      logger.error('Template fetch failed', {
        error: (error as Error).message,
      });
      return res.status(500).json({
        error: 'Failed to retrieve template',
      });
    }
  });

  /**
   * PUT /api/templates/:id
   * Update template metadata or create new version
   */
  router.put('/:id', requireAdminAuth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { name, category, status, description } = req.body;

      const updateFields = [];
      const updateParams = [];
      let paramIndex = 1;

      if (name) {
        updateFields.push(`name = $${paramIndex++}`);
        updateParams.push(name);
      }
      if (category) {
        updateFields.push(`category = $${paramIndex++}`);
        updateParams.push(category);
      }
      if (status) {
        updateFields.push(`status = $${paramIndex++}`);
        updateParams.push(status);
        if (status === 'deprecated') {
          updateFields.push(`deprecated_at = CURRENT_TIMESTAMP`);
        }
      }
      if (description) {
        updateFields.push(`description = $${paramIndex++}`);
        updateParams.push(description);
      }

      if (updateFields.length === 0) {
        return res.status(400).json({
          error: 'No fields to update',
        });
      }

      updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
      updateParams.push(id);

      const query = `UPDATE question_templates
                    SET ${updateFields.join(', ')}
                    WHERE id = $${paramIndex}
                    RETURNING id, name, category, status, updated_at`;

      const result = await db.query(query, updateParams);

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Template not found',
        });
      }

      logger.info('Template updated', {
        templateId: id,
        updatedFields: Object.keys(req.body),
      });

      return res.status(200).json({
        template: result.rows[0],
      });
    } catch (error) {
      logger.error('Template update failed', {
        error: (error as Error).message,
      });
      return res.status(500).json({
        error: 'Update failed',
      });
    }
  });

  /**
   * DELETE /api/templates/:id
   * Soft-delete a template (deprecate)
   */
  router.delete('/:id', requireAdminAuth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const result = await db.query(
        `UPDATE question_templates
        SET status = 'deprecated', deprecated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING id, status`,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Template not found',
        });
      }

      logger.info('Template deprecated', {
        templateId: id,
      });

      return res.status(200).json({
        templateId: id,
        status: 'deprecated',
      });
    } catch (error) {
      logger.error('Template deprecation failed', {
        error: (error as Error).message,
      });
      return res.status(500).json({
        error: 'Deprecation failed',
      });
    }
  });

  // ============================================================================
  // Recommendations Endpoints
  // ============================================================================

  /**
   * GET /api/templates/recommendations/for-me
   * Get personalized template recommendations
   */
  router.get('/recommendations/for-me', requireAuth, async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.id || 'anonymous';
      const { limit = 10 } = req.query;
      const limitNum = Math.min(parseInt(limit as string, 10) || 10, 50);

      const result = await db.query(
        `SELECT tr.id, tr.template_id, qt.name, qt.category, tr.strategy,
                tr.strategy_score, tr.combined_score, tr.reason, tr.confidence
        FROM template_recommendations tr
        JOIN question_templates qt ON tr.template_id = qt.id
        WHERE tr.user_id = $1 AND tr.expires_at > CURRENT_TIMESTAMP
        ORDER BY tr.combined_score DESC
        LIMIT $2`,
        [userId, limitNum]
      );

      logger.info('Recommendations retrieved', {
        userId,
        count: result.rows.length,
      });

      return res.status(200).json({
        recommendations: result.rows,
      });
    } catch (error) {
      logger.error('Recommendations failed', {
        error: (error as Error).message,
      });
      return res.status(500).json({
        error: 'Failed to retrieve recommendations',
      });
    }
  });

  /**
   * GET /api/templates/trending
   * Get trending templates for the period
   */
  router.get('/trending', async (req: Request, res: Response) => {
    try {
      const { days = 7, limit = 20 } = req.query;
      const daysNum = parseInt(days as string, 10) || 7;
      const limitNum = Math.min(parseInt(limit as string, 10) || 20, 100);

      const result = await db.query(
        `SELECT qt.id, qt.name, qt.category, qt.quality_score, qt.success_rate,
                SUM(tum.usage_count) as uses, AVG(tum.avg_rating) as avg_rating
        FROM question_templates qt
        LEFT JOIN template_usage_metrics tum ON qt.id = tum.template_id
          AND tum.metric_date >= CURRENT_DATE - INTERVAL '1 day' * $1
        WHERE qt.status = 'active'
        GROUP BY qt.id
        ORDER BY uses DESC, qt.quality_score DESC
        LIMIT $2`,
        [daysNum, limitNum]
      );

      return res.status(200).json({
        period: `${daysNum} days`,
        templates: result.rows,
      });
    } catch (error) {
      logger.error('Trending query failed', {
        error: (error as Error).message,
      });
      return res.status(500).json({
        error: 'Failed to retrieve trending templates',
      });
    }
  });

  // ============================================================================
  // Feedback & Rating Endpoints
  // ============================================================================

  /**
   * POST /api/templates/:id/feedback
   * Submit feedback on a template
   */
  router.post('/:id/feedback', requireAuth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { rating, wasHelpful, improvementSuggestion, accuracyIssue, missingInformation } =
        req.body;
      const authReq = req as AuthenticatedRequest;

      if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({
          error: 'Invalid rating: must be between 1 and 5',
        });
      }

      const result = await db.query(
        `INSERT INTO template_feedback
        (user_id, template_id, rating, was_helpful, improvement_suggestion, accuracy_issue, missing_information)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, rating`,
        [
          authReq.user?.id,
          id,
          rating,
          wasHelpful,
          improvementSuggestion,
          accuracyIssue,
          missingInformation,
        ]
      );

      if (!result.rows.length) {
        return res.status(400).json({
          error: 'Failed to submit feedback',
        });
      }

      logger.info('Feedback submitted', {
        templateId: id,
        rating,
        userId: authReq.user?.id,
      });

      return res.status(201).json({
        feedbackId: result.rows[0].id,
        status: 'submitted',
      });
    } catch (error) {
      logger.error('Feedback submission failed', {
        error: (error as Error).message,
      });
      return res.status(500).json({
        error: 'Feedback submission failed',
      });
    }
  });

  /**
   * POST /api/templates/:id/rate
   * Submit a rating for a template (simplified)
   */
  router.post('/:id/rate', requireAuth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { rating } = req.body;

      if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({
          error: 'Invalid rating: must be between 1 and 5',
        });
      }

      await db.query(
        `INSERT INTO template_feedback (user_id, template_id, rating, was_helpful)
        VALUES ($1, $2, $3, $4)`,
        [(req as AuthenticatedRequest).user?.id, id, rating, rating >= 4]
      );

      // Update template quality score (TBD: Better aggregation)
      const statsResult = await db.query(
        `SELECT AVG(rating) as avg_rating, COUNT(*) as total
        FROM template_feedback
        WHERE template_id = $1`,
        [id]
      );

      const stats = statsResult.rows[0];

      await db.query(
        `UPDATE question_templates
        SET user_satisfaction = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2`,
        [stats.avg_rating || 0, id]
      );

      return res.status(200).json({
        templateId: id,
        averageRating: stats.avg_rating,
        totalRatings: stats.total,
      });
    } catch (error) {
      logger.error('Rating failed', {
        error: (error as Error).message,
      });
      return res.status(500).json({
        error: 'Rating failed',
      });
    }
  });

  // ============================================================================
  // Analytics Endpoints
  // ============================================================================

  /**
   * GET /api/templates/:id/metrics
   * Get metrics for a specific template
   */
  router.get('/:id/metrics', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { days = 30 } = req.query;
      const daysNum = parseInt(days as string, 10) || 30;

      const templateResult = await db.query(
        `SELECT id, quality_score, success_rate, user_satisfaction, total_uses,
                generation_cost_usd, avg_execution_cost_usd
        FROM question_templates
        WHERE id = $1`,
        [id]
      );

      if (templateResult.rows.length === 0) {
        return res.status(404).json({
          error: 'Template not found',
        });
      }

      const template = templateResult.rows[0];

      // Get period metrics
      const metricsResult = await db.query(
        `SELECT
          SUM(usage_count) as total_uses,
          AVG(avg_rating) as avg_rating,
          SUM(helpful_count) as helpful_count,
          SUM(total_cost_usd) as total_cost,
          AVG(avg_execution_time_ms) as avg_latency_ms
        FROM template_usage_metrics
        WHERE template_id = $1 AND metric_date >= CURRENT_DATE - INTERVAL '1 day' * $2`,
        [id, daysNum]
      );

      const metrics = metricsResult.rows[0];

      return res.status(200).json({
        templateId: id,
        overall: template,
        period: {
          days: daysNum,
          ...metrics,
        },
      });
    } catch (error) {
      logger.error('Metrics query failed', {
        error: (error as Error).message,
      });
      return res.status(500).json({
        error: 'Failed to retrieve metrics',
      });
    }
  });

  /**
   * GET /api/templates/analytics/dashboard
   * Get analytics dashboard data
   */
  router.get('/analytics/dashboard', async (req: Request, res: Response) => {
    try {
      // Top templates
      const topResult = await db.query(
        `SELECT id, name, category, quality_score, total_uses, user_satisfaction
        FROM question_templates
        WHERE status = 'active'
        ORDER BY quality_score DESC
        LIMIT 10`
      );

      // Declining templates
      const decliningResult = await db.query(`SELECT * FROM declining_templates LIMIT 10`);

      // Template statistics
      const statsResult = await db.query(
        `SELECT
          COUNT(*) as total_templates,
          COUNT(CASE WHEN status = 'active' THEN 1 END) as active_templates,
          AVG(quality_score) as avg_quality_score,
          AVG(success_rate) as avg_success_rate
        FROM question_templates`
      );

      // Recent generations
      const generationsResult = await db.query(
        `SELECT id, approval_status, status, created_at
        FROM template_generations
        ORDER BY created_at DESC
        LIMIT 10`
      );

      return res.status(200).json({
        topTemplates: topResult.rows,
        decliningTemplates: decliningResult.rows,
        statistics: statsResult.rows[0],
        recentGenerations: generationsResult.rows,
      });
    } catch (error) {
      logger.error('Dashboard query failed', {
        error: (error as Error).message,
      });
      return res.status(500).json({
        error: 'Failed to retrieve dashboard data',
      });
    }
  });

  /**
   * POST /api/templates/metrics/aggregate
   * Manually trigger metrics aggregation (admin only)
   */
  router.post('/metrics/aggregate', requireAdminAuth, async (req: Request, res: Response) => {
    try {
      const { templateId, date } = req.body;

      if (!templateId || !date) {
        return res.status(400).json({
          error: 'Missing required fields: templateId, date',
        });
      }

      // Call SQL function to aggregate metrics
      await db.query(`SELECT aggregate_template_metrics($1::UUID, $2::DATE)`, [templateId, date]);

      logger.info('Metrics aggregated', {
        templateId,
        date,
      });

      return res.status(200).json({
        status: 'aggregated',
        templateId,
        date,
      });
    } catch (error) {
      logger.error('Aggregation failed', {
        error: (error as Error).message,
      });
      return res.status(500).json({
        error: 'Aggregation failed',
      });
    }
  });

  return router;
}
