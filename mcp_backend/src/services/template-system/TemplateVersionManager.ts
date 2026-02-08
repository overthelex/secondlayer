/**
 * TemplateVersionManager Service
 *
 * Manages template version lifecycle, promotions, and user segment selection.
 * Implements smart promotion logic:
 *
 * Workflow:
 * 1. New version created → draft status
 * 2. Admin promotes → candidate (limited testing)
 * 3. Metrics improve → ready_for_promotion flag
 * 4. Auto/manual promotion → released (for specific user_segment)
 * 5. New version replaces → old version deprecated
 *
 * User Segments:
 * - general: default (all users)
 * - individual: физ лица
 * - legal_entity: юр лица
 * - government: державні установи
 * - corporate: корпоративні клієнти
 */

import { BaseDatabase, logger } from '@secondlayer/shared';

export interface VersionMetrics {
  versionId: string;
  versionNumber: string;
  userSegment: string;
  status: 'draft' | 'candidate' | 'released' | 'deprecated';

  // Usage
  totalUses: number;
  uses30d: number;
  uses7d: number;

  // Quality
  avgRating: number;
  totalRatings: number;
  helpfulCount: number;
  unhelpfulCount: number;

  // Success metrics
  successRate: number;  // 0-100
  userSatisfaction: number;  // 0-5

  // Costs
  totalCostUsd: number;
  avgExecutionCostUsd: number;

  // Performance
  avgExecutionTimeMs: number;

  // Promotion
  roi30d: number;
  promotionScore: number;  // 0-100 composite score
  readyForPromotion: boolean;
}

export interface PromotionRequest {
  templateId: string;
  versionId: string;
  userSegment: string;
  fromStatus: 'draft' | 'candidate' | 'released';
  toStatus: 'candidate' | 'released' | 'deprecated';
  promotedBy: string;
  reason?: string;
}

export interface PromotionEligibility {
  versionId: string;
  versionNumber: string;
  userSegment: string;
  currentStatus: string;

  // Metrics
  totalUses: number;
  avgRating: number;
  successRate: number;
  daysActive: number;

  // Eligibility
  meetsUsageRequirement: boolean;
  meetsRatingRequirement: boolean;
  meetsSuccessRequirement: boolean;
  meetsDaysRequirement: boolean;
  isEligible: boolean;

  // Recommendation
  recommendedNextStatus: 'candidate' | 'released' | 'hold' | null;
  recommendationReason: string;
}

export class TemplateVersionManager {
  constructor(private db: BaseDatabase) {}

  /**
   * Get best version for a user segment
   * Returns the "released" version for that segment
   * Falls back to "general" segment if specific not found
   */
  async getBestVersionForSegment(
    templateId: string,
    userSegment: string = 'general'
  ): Promise<VersionMetrics | null> {
    try {
      // Try to find version for specific segment
      let result = await this.db.query(
        `SELECT
          tv.id as version_id,
          tv.version_number,
          tv.status,
          tv.user_segment,
          tvm.total_uses,
          tvm.uses_30d,
          tvm.uses_7d,
          tvm.avg_rating,
          tvm.total_ratings,
          tvm.helpful_count,
          tvm.unhelpful_count,
          tvm.success_rate,
          tvm.user_satisfaction,
          tvm.total_cost_usd,
          tvm.avg_execution_cost_usd,
          tvm.avg_execution_time_ms,
          tvm.roi_30d,
          tvm.promotion_score,
          tvm.ready_for_promotion
        FROM template_versions tv
        JOIN template_version_metrics tvm ON tvm.version_id = tv.id
        WHERE tv.template_id = $1
          AND tv.is_default_for_segment = TRUE
          AND tv.user_segment = $2
        LIMIT 1`,
        [templateId, userSegment]
      );

      // If not found for specific segment, try general
      if (result.rows.length === 0) {
        result = await this.db.query(
          `SELECT
            tv.id as version_id,
            tv.version_number,
            tv.status,
            tv.user_segment,
            tvm.total_uses,
            tvm.uses_30d,
            tvm.uses_7d,
            tvm.avg_rating,
            tvm.total_ratings,
            tvm.helpful_count,
            tvm.unhelpful_count,
            tvm.success_rate,
            tvm.user_satisfaction,
            tvm.total_cost_usd,
            tvm.avg_execution_cost_usd,
            tvm.avg_execution_time_ms,
            tvm.roi_30d,
            tvm.promotion_score,
            tvm.ready_for_promotion
          FROM template_versions tv
          JOIN template_version_metrics tvm ON tvm.version_id = tv.id
          WHERE tv.template_id = $1
            AND tv.is_default_for_segment = TRUE
            AND tv.user_segment = 'general'
          LIMIT 1`,
          [templateId]
        );
      }

      if (result.rows.length === 0) {
        return null;
      }

      return this.mapRowToMetrics(result.rows[0]);
    } catch (error) {
      logger.error('Failed to get best version for segment', {
        error: (error as Error).message,
        templateId,
        userSegment,
      });
      throw error;
    }
  }

  /**
   * Get all versions of a template with metrics
   */
  async getVersionsWithMetrics(
    templateId: string,
    userSegment?: string
  ): Promise<VersionMetrics[]> {
    try {
      let query = `SELECT
        tv.id as version_id,
        tv.version_number,
        tv.status,
        tv.user_segment,
        tvm.total_uses,
        tvm.uses_30d,
        tvm.uses_7d,
        tvm.avg_rating,
        tvm.total_ratings,
        tvm.helpful_count,
        tvm.unhelpful_count,
        tvm.success_rate,
        tvm.user_satisfaction,
        tvm.total_cost_usd,
        tvm.avg_execution_cost_usd,
        tvm.avg_execution_time_ms,
        tvm.roi_30d,
        tvm.promotion_score,
        tvm.ready_for_promotion
      FROM template_versions tv
      JOIN template_version_metrics tvm ON tvm.version_id = tv.id
      WHERE tv.template_id = $1`;

      const params: any[] = [templateId];

      if (userSegment) {
        query += ` AND tv.user_segment = $${params.length + 1}`;
        params.push(userSegment);
      }

      query += ` ORDER BY tv.released_at DESC`;

      const result = await this.db.query(query, params);

      return result.rows.map((row) => this.mapRowToMetrics(row));
    } catch (error) {
      logger.error('Failed to get versions with metrics', {
        error: (error as Error).message,
        templateId,
      });
      throw error;
    }
  }

  /**
   * Promote version to next status (draft → candidate → released)
   */
  async promoteVersion(request: PromotionRequest): Promise<void> {
    try {
      // Start transaction
      await this.db.query('BEGIN');

      // Get current version
      const versionResult = await this.db.query(
        `SELECT id, status, user_segment FROM template_versions WHERE id = $1`,
        [request.versionId]
      );

      if (versionResult.rows.length === 0) {
        throw new Error(`Version ${request.versionId} not found`);
      }

      const version = versionResult.rows[0];

      // Validate status transition
      this.validateStatusTransition(version.status, request.toStatus);

      // Get metrics for promotion history
      const metricsResult = await this.db.query(
        `SELECT total_uses, avg_rating, success_rate FROM template_version_metrics WHERE version_id = $1`,
        [request.versionId]
      );

      const metrics = metricsResult.rows[0] || {};

      // Update version status
      await this.db.query(
        `UPDATE template_versions
        SET status = $1,
            promoted_at = CURRENT_TIMESTAMP,
            promoted_by = $2,
            promotion_reason = $3,
            is_default_for_segment = (CASE WHEN $1 = 'released' THEN TRUE ELSE FALSE END)
        WHERE id = $4`,
        [request.toStatus, request.promotedBy, request.reason, request.versionId]
      );

      // If promoting to released, deprecate old versions for same segment
      if (request.toStatus === 'released') {
        await this.db.query(
          `UPDATE template_versions
          SET status = 'deprecated',
              is_default_for_segment = FALSE
          WHERE template_id = $1
            AND user_segment = $2
            AND id != $3
            AND status = 'released'`,
          [request.templateId, request.userSegment, request.versionId]
        );
      }

      // Record promotion in history
      await this.db.query(
        `INSERT INTO template_promotion_history
        (template_id, version_id, version_number, user_segment, from_status, to_status,
         promoted_by, promotion_reason, uses_at_promotion, avg_rating_at_promotion,
         success_rate_at_promotion)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          request.templateId,
          request.versionId,
          (versionResult.rows[0] as any).version_number,
          request.userSegment,
          version.status,
          request.toStatus,
          request.promotedBy,
          request.reason || null,
          metrics.total_uses || 0,
          metrics.avg_rating || 0,
          metrics.success_rate || 0,
        ]
      );

      await this.db.query('COMMIT');

      logger.info('Version promoted', {
        templateId: request.templateId,
        versionId: request.versionId,
        fromStatus: version.status,
        toStatus: request.toStatus,
        userSegment: request.userSegment,
      });
    } catch (error) {
      await this.db.query('ROLLBACK');
      logger.error('Promotion failed', {
        error: (error as Error).message,
        versionId: request.versionId,
      });
      throw error;
    }
  }

  /**
   * Check if version is eligible for promotion
   */
  async checkPromotionEligibility(
    versionId: string
  ): Promise<PromotionEligibility | null> {
    try {
      const result = await this.db.query(
        `SELECT
          tv.id,
          tv.version_number,
          tv.status,
          tv.user_segment,
          tv.released_at,
          tvm.total_uses,
          tvm.avg_rating,
          tvm.success_rate,
          tvm.promotion_score
        FROM template_versions tv
        LEFT JOIN template_version_metrics tvm ON tvm.version_id = tv.id
        WHERE tv.id = $1`,
        [versionId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      const daysActive = row.released_at
        ? Math.floor((Date.now() - new Date(row.released_at).getTime()) / (1000 * 60 * 60 * 24))
        : 0;

      const meetsUsageRequirement = (row.total_uses || 0) >= 10;
      const meetsRatingRequirement = (row.avg_rating || 0) >= 4.0;
      const meetsSuccessRequirement = (row.success_rate || 0) >= 70;
      const meetsDaysRequirement = daysActive >= 3;

      const isEligible = meetsUsageRequirement && meetsRatingRequirement && meetsSuccessRequirement && meetsDaysRequirement;

      let recommendedNextStatus: 'candidate' | 'released' | 'hold' | null = null;
      let recommendationReason = '';

      if (row.status === 'draft') {
        recommendedNextStatus = 'candidate';
        recommendationReason = 'Ready for limited rollout testing';
      } else if (row.status === 'candidate' && isEligible) {
        recommendedNextStatus = 'released';
        recommendationReason = `Strong metrics: ${row.total_uses} uses, ${row.avg_rating}/5 rating, ${row.success_rate}% success`;
      } else if (row.status === 'candidate') {
        recommendedNextStatus = 'hold';
        if (!meetsUsageRequirement) recommendationReason += ` Uses: ${row.total_uses}/10.`;
        if (!meetsRatingRequirement) recommendationReason += ` Rating: ${row.avg_rating}/4.0.`;
        if (!meetsSuccessRequirement) recommendationReason += ` Success: ${row.success_rate}%/70%.`;
        if (!meetsDaysRequirement) recommendationReason += ` Days: ${daysActive}/3.`;
      }

      return {
        versionId,
        versionNumber: row.version_number,
        userSegment: row.user_segment,
        currentStatus: row.status,
        totalUses: row.total_uses || 0,
        avgRating: row.avg_rating || 0,
        successRate: row.success_rate || 0,
        daysActive,
        meetsUsageRequirement,
        meetsRatingRequirement,
        meetsSuccessRequirement,
        meetsDaysRequirement,
        isEligible,
        recommendedNextStatus,
        recommendationReason,
      };
    } catch (error) {
      logger.error('Failed to check promotion eligibility', {
        error: (error as Error).message,
        versionId,
      });
      throw error;
    }
  }

  /**
   * Run auto-promotion job (call daily)
   * Promotes candidates to released if metrics excellent
   */
  async runAutoPromotionJob(): Promise<{ promoted: number }> {
    try {
      const result = await this.db.query(`
        WITH promoted AS (
          SELECT template_id, version_id, version_number, user_segment
          FROM auto_promote_versions()
        )
        SELECT COUNT(*) as count FROM promoted
      `);

      const promotedCount = parseInt(result.rows[0]?.count || '0', 10);

      logger.info('Auto-promotion job completed', {
        promoted: promotedCount,
      });

      return { promoted: promotedCount };
    } catch (error) {
      logger.error('Auto-promotion job failed', {
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Update promotion scores for all versions (call daily)
   */
  async updatePromotionScores(): Promise<{ updated: number }> {
    try {
      const result = await this.db.query(`
        SELECT * FROM update_version_promotion_scores()
      `);

      const updated = result.rows[0]?.[0] || 0;

      logger.info('Promotion scores updated', { updated });

      return { updated };
    } catch (error) {
      logger.error('Failed to update promotion scores', {
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Get promotion history for a template
   */
  async getPromotionHistory(templateId: string, limit = 50) {
    try {
      const result = await this.db.query(
        `SELECT
          id,
          version_number,
          user_segment,
          from_status,
          to_status,
          promoted_by,
          promotion_reason,
          uses_at_promotion,
          avg_rating_at_promotion,
          success_rate_at_promotion,
          promoted_at
        FROM template_promotion_history
        WHERE template_id = $1
        ORDER BY promoted_at DESC
        LIMIT $2`,
        [templateId, limit]
      );

      return result.rows;
    } catch (error) {
      logger.error('Failed to get promotion history', {
        error: (error as Error).message,
        templateId,
      });
      throw error;
    }
  }

  /**
   * Private: Validate status transition
   */
  private validateStatusTransition(from: string, to: string): void {
    const validTransitions: Record<string, string[]> = {
      draft: ['candidate'],
      candidate: ['released', 'deprecated'],
      released: ['deprecated'],
      deprecated: [], // No transitions from deprecated
    };

    if (!validTransitions[from]?.includes(to)) {
      throw new Error(`Invalid status transition: ${from} → ${to}`);
    }
  }

  /**
   * Private: Map database row to VersionMetrics
   */
  private mapRowToMetrics(row: any): VersionMetrics {
    return {
      versionId: row.version_id,
      versionNumber: row.version_number,
      userSegment: row.user_segment,
      status: row.status,
      totalUses: row.total_uses || 0,
      uses30d: row.uses_30d || 0,
      uses7d: row.uses_7d || 0,
      avgRating: parseFloat(row.avg_rating || 0),
      totalRatings: row.total_ratings || 0,
      helpfulCount: row.helpful_count || 0,
      unhelpfulCount: row.unhelpful_count || 0,
      successRate: parseFloat(row.success_rate || 0),
      userSatisfaction: parseFloat(row.user_satisfaction || 0),
      totalCostUsd: parseFloat(row.total_cost_usd || 0),
      avgExecutionCostUsd: parseFloat(row.avg_execution_cost_usd || 0),
      avgExecutionTimeMs: row.avg_execution_time_ms || 0,
      roi30d: parseFloat(row.roi_30d || 0),
      promotionScore: parseFloat(row.promotion_score || 0),
      readyForPromotion: row.ready_for_promotion || false,
    };
  }
}

/**
 * Singleton instance management
 */
let templateVersionManagerInstance: TemplateVersionManager | null = null;

export function getTemplateVersionManager(db?: BaseDatabase): TemplateVersionManager {
  if (!templateVersionManagerInstance && db) {
    templateVersionManagerInstance = new TemplateVersionManager(db);
  }
  if (!templateVersionManagerInstance) {
    throw new Error('TemplateVersionManager not initialized');
  }
  return templateVersionManagerInstance;
}
