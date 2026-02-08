/**
 * TemplateStorage Service
 *
 * Handles CRUD operations, versioning, and lifecycle management for templates.
 * - Save approved templates from generation queue
 * - Manage template versions (MAJOR/MINOR/PATCH)
 * - Handle template deprecation and archival
 * - Track template metadata and metrics
 */

import { BaseDatabase, logger } from '@secondlayer/shared';
import { GeneratedTemplate, TemplateVersion } from './types.js';

export interface CreateTemplateOptions {
  name: string;
  category: string;
  promptTemplate: string;
  inputSchema: Record<string, any>;
  outputSchema: Record<string, any>;
  instructions: string;
  exampleInput: Record<string, any>;
  exampleOutput: Record<string, any>;
  intentKeywords: string[];
  description?: string;
  generationCostUsd?: number;
  generatedFromId?: string; // Reference to template_generations.id
  createdBy?: string;
}

export interface UpdateTemplateOptions {
  name?: string;
  description?: string;
  instructions?: string;
  exampleInput?: Record<string, any>;
  exampleOutput?: Record<string, any>;
  status?: 'active' | 'deprecated' | 'archived';
  changeType?: 'minor' | 'major' | 'patch';
  changeDescription?: string;
  createdBy?: string;
}

export class TemplateStorage {
  constructor(private db: BaseDatabase) {}

  /**
   * Create a new template from approved generation
   * Initializes version 1.0.0 and sets up initial metrics
   */
  async createTemplate(options: CreateTemplateOptions): Promise<string> {
    const templateId = require('crypto').randomUUID();
    const version = '1.0.0';

    try {
      // Start transaction
      await this.db.query('BEGIN');

      // Create template record
      await this.db.query(
        `INSERT INTO question_templates
        (id, name, category, intent_keywords, prompt_template, input_schema, output_schema,
         description, instructions, example_input, example_output, status, current_version,
         generation_cost_usd, created_by, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          templateId,
          options.name,
          options.category,
          options.intentKeywords,
          options.promptTemplate,
          JSON.stringify(options.inputSchema),
          JSON.stringify(options.outputSchema),
          options.description || '',
          options.instructions,
          JSON.stringify(options.exampleInput),
          JSON.stringify(options.exampleOutput),
          'active',
          version,
          options.generationCostUsd || 0,
          options.createdBy || 'system',
        ]
      );

      // Create initial version record
      await this.db.query(
        `INSERT INTO template_versions
        (template_id, version_number, change_type, change_description, released_at, is_current, is_supported)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5, $6)`,
        [templateId, version, 'initial', 'Template creation from generation', true, true]
      );

      // Create initial metrics record
      await this.db.query(
        `INSERT INTO template_usage_metrics
        (template_id, metric_date, usage_count, avg_rating, helpful_count, total_cost_usd, avg_execution_time_ms)
        VALUES ($1, CURRENT_DATE, 0, 0, 0, 0, 0)`,
        [templateId]
      );

      // Link to generation if provided
      if (options.generatedFromId) {
        await this.db.query(
          `UPDATE template_generations
          SET template_id = $1, status = 'template_created'
          WHERE id = $2`,
          [templateId, options.generatedFromId]
        );
      }

      await this.db.query('COMMIT');

      logger.info('Template created', {
        templateId,
        name: options.name,
        category: options.category,
        version,
      });

      return templateId;
    } catch (error) {
      await this.db.query('ROLLBACK');
      logger.error('Failed to create template', {
        error: (error as Error).message,
        name: options.name,
      });
      throw error;
    }
  }

  /**
   * Update template and optionally create new version
   * If changeType is specified, creates a new version (MAJOR/MINOR/PATCH)
   */
  async updateTemplate(templateId: string, options: UpdateTemplateOptions): Promise<void> {
    try {
      const updateFields = [];
      const updateParams = [];
      let paramIndex = 1;

      if (options.name) {
        updateFields.push(`name = $${paramIndex++}`);
        updateParams.push(options.name);
      }
      if (options.description !== undefined) {
        updateFields.push(`description = $${paramIndex++}`);
        updateParams.push(options.description);
      }
      if (options.instructions) {
        updateFields.push(`instructions = $${paramIndex++}`);
        updateParams.push(options.instructions);
      }
      if (options.exampleInput) {
        updateFields.push(`example_input = $${paramIndex++}`);
        updateParams.push(JSON.stringify(options.exampleInput));
      }
      if (options.exampleOutput) {
        updateFields.push(`example_output = $${paramIndex++}`);
        updateParams.push(JSON.stringify(options.exampleOutput));
      }
      if (options.status) {
        updateFields.push(`status = $${paramIndex++}`);
        updateParams.push(options.status);
        if (options.status === 'deprecated') {
          updateFields.push(`deprecated_at = CURRENT_TIMESTAMP`);
        }
      }

      if (updateFields.length === 0 && !options.changeType) {
        logger.warn('No fields to update for template', { templateId });
        return;
      }

      // Get current version for versioning
      const versionResult = await this.db.query(
        `SELECT current_version FROM question_templates WHERE id = $1`,
        [templateId]
      );

      if (versionResult.rows.length === 0) {
        throw new Error(`Template ${templateId} not found`);
      }

      const currentVersion = versionResult.rows[0].current_version;
      let newVersion = currentVersion;

      // Update template if there are changes
      if (updateFields.length > 0) {
        updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
        updateParams.push(templateId);

        const query = `UPDATE question_templates
                      SET ${updateFields.join(', ')}
                      WHERE id = $${paramIndex}`;

        await this.db.query(query, updateParams);
      }

      // Create new version if changeType is specified
      if (options.changeType) {
        newVersion = this.incrementVersion(currentVersion, options.changeType);

        await this.db.query(
          `INSERT INTO template_versions
          (template_id, version_number, change_type, change_description, released_at, is_current, is_supported)
          VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5, $6)`,
          [
            templateId,
            newVersion,
            options.changeType,
            options.changeDescription || 'Template update',
            true,
            true,
          ]
        );

        // Update current version in template
        await this.db.query(
          `UPDATE question_templates SET current_version = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [newVersion, templateId]
        );

        // Mark old version as not current
        await this.db.query(
          `UPDATE template_versions SET is_current = false WHERE template_id = $1 AND version_number != $2`,
          [templateId, newVersion]
        );
      }

      logger.info('Template updated', {
        templateId,
        newVersion,
        changeType: options.changeType,
      });
    } catch (error) {
      logger.error('Failed to update template', {
        error: (error as Error).message,
        templateId,
      });
      throw error;
    }
  }

  /**
   * Get template by ID with full details
   */
  async getTemplate(templateId: string) {
    try {
      const result = await this.db.query(
        `SELECT id, name, category, intent_keywords, prompt_template, input_schema, output_schema,
                description, instructions, example_input, example_output, status, current_version,
                quality_score, success_rate, user_satisfaction, total_uses,
                generation_cost_usd, avg_execution_cost_usd, created_at, updated_at, deprecated_at
        FROM question_templates
        WHERE id = $1`,
        [templateId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const template = result.rows[0];

      // Get versions
      const versionsResult = await this.db.query(
        `SELECT version_number, change_type, change_description, released_at, is_current, is_supported
        FROM template_versions
        WHERE template_id = $1
        ORDER BY released_at DESC`,
        [templateId]
      );

      return {
        ...template,
        inputSchema: template.input_schema ? JSON.parse(template.input_schema) : {},
        outputSchema: template.output_schema ? JSON.parse(template.output_schema) : {},
        exampleInput: template.example_input ? JSON.parse(template.example_input) : {},
        exampleOutput: template.example_output ? JSON.parse(template.example_output) : {},
        versions: versionsResult.rows,
      };
    } catch (error) {
      logger.error('Failed to get template', {
        error: (error as Error).message,
        templateId,
      });
      throw error;
    }
  }

  /**
   * List templates with filtering and pagination
   */
  async listTemplates(
    options: {
      category?: string;
      status?: 'active' | 'deprecated' | 'archived';
      limit?: number;
      offset?: number;
    } = {}
  ) {
    try {
      const { category, status = 'active', limit = 50, offset = 0 } = options;
      const limitNum = Math.min(limit, 500);

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
      params.push(limitNum, offset);

      const result = await this.db.query(query, params);

      // Get count
      let countQuery = 'SELECT COUNT(*) as count FROM question_templates WHERE status = $1';
      const countParams: any[] = [status];
      if (category) {
        countQuery += ` AND category = $${countParams.length + 1}`;
        countParams.push(category);
      }
      const countResult = await this.db.query(countQuery, countParams);
      const total = parseInt(countResult.rows[0]?.count || '0', 10);

      return {
        templates: result.rows,
        total,
        limit: limitNum,
        offset,
        hasMore: offset + limitNum < total,
      };
    } catch (error) {
      logger.error('Failed to list templates', {
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Deprecate a template (soft delete)
   * Marks template as deprecated but keeps it for historical reference
   */
  async deprecateTemplate(templateId: string, reason?: string): Promise<void> {
    try {
      await this.db.query(
        `UPDATE question_templates
        SET status = 'deprecated', deprecated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
        [templateId]
      );

      if (reason) {
        logger.info('Template deprecated', {
          templateId,
          reason,
        });
      }
    } catch (error) {
      logger.error('Failed to deprecate template', {
        error: (error as Error).message,
        templateId,
      });
      throw error;
    }
  }

  /**
   * Archive a template (historical records only)
   * Generally done after 90 days of deprecation
   */
  async archiveTemplate(templateId: string): Promise<void> {
    try {
      await this.db.query(
        `UPDATE question_templates
        SET status = 'archived', updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'deprecated'`,
        [templateId]
      );

      logger.info('Template archived', { templateId });
    } catch (error) {
      logger.error('Failed to archive template', {
        error: (error as Error).message,
        templateId,
      });
      throw error;
    }
  }

  /**
   * Get template metrics for a period
   */
  async getMetrics(templateId: string, days: number = 30) {
    try {
      // Overall metrics
      const overallResult = await this.db.query(
        `SELECT quality_score, success_rate, user_satisfaction, total_uses,
                generation_cost_usd, avg_execution_cost_usd
        FROM question_templates
        WHERE id = $1`,
        [templateId]
      );

      if (overallResult.rows.length === 0) {
        throw new Error(`Template ${templateId} not found`);
      }

      // Period metrics
      const periodResult = await this.db.query(
        `SELECT
          SUM(usage_count) as total_uses,
          AVG(avg_rating) as avg_rating,
          SUM(helpful_count) as helpful_count,
          SUM(total_cost_usd) as total_cost,
          AVG(avg_execution_time_ms) as avg_latency_ms,
          COUNT(*) as days_active
        FROM template_usage_metrics
        WHERE template_id = $1 AND metric_date >= CURRENT_DATE - INTERVAL '1 day' * $2`,
        [templateId, days]
      );

      return {
        overall: overallResult.rows[0],
        period: {
          days,
          ...periodResult.rows[0],
        },
      };
    } catch (error) {
      logger.error('Failed to get template metrics', {
        error: (error as Error).message,
        templateId,
      });
      throw error;
    }
  }

  /**
   * Increment version number based on change type
   * MAJOR: x.0.0, MINOR: x.y.0, PATCH: x.y.z
   */
  private incrementVersion(currentVersion: string, changeType: 'major' | 'minor' | 'patch'): string {
    const parts = currentVersion.split('.').map(Number);
    if (parts.length !== 3) {
      logger.warn('Invalid version format', { currentVersion });
      return '1.0.0';
    }

    const [major, minor, patch] = parts;

    switch (changeType) {
      case 'major':
        return `${major + 1}.0.0`;
      case 'minor':
        return `${major}.${minor + 1}.0`;
      case 'patch':
        return `${major}.${minor}.${patch + 1}`;
      default:
        return currentVersion;
    }
  }
}

/**
 * Singleton instance management
 */
let templateStorageInstance: TemplateStorage | null = null;

export function getTemplateStorage(db?: BaseDatabase): TemplateStorage {
  if (!templateStorageInstance && db) {
    templateStorageInstance = new TemplateStorage(db);
  }
  if (!templateStorageInstance) {
    throw new Error('TemplateStorage not initialized');
  }
  return templateStorageInstance;
}
