/**
 * ADR-002: PromptLifecycleManager
 *
 * Tracks prompt execution history for observability and debugging.
 * Records prompt instances and their execution results to PostgreSQL.
 */

import type { Pool } from 'pg';
import type { PromptInstance, PromptExecutionResult } from '../../types/prompt.js';

export class PromptLifecycleManager {
  constructor(private pool: Pool) {}

  /**
   * Record a prompt instance (assembled prompt)
   */
  async recordInstance(instance: PromptInstance): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO prompt_instances (
          instance_id, intent_name, template_id, template_version,
          system_instructions, user_message, sources, constraints,
          assembled_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (instance_id) DO NOTHING`,
        [
          instance.metadata.instance_id,
          instance.intent.name,
          instance.metadata.template_id,
          instance.metadata.version,
          JSON.stringify(instance.system),
          instance.user,
          JSON.stringify(instance.sources),
          JSON.stringify(instance.constraints),
          instance.metadata.assembled_at
        ]
      );
    } catch (error) {
      console.error('Error recording prompt instance:', error);
      // Don't throw - lifecycle tracking shouldn't break the main flow
    }
  }

  /**
   * Record a prompt execution result
   */
  async recordExecution(result: PromptExecutionResult): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO prompt_executions (
          instance_id, model_used, tokens_input, tokens_output,
          cost_usd, execution_time_ms, validation_passed, retry_count,
          output, error, executed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          result.instance_id,
          result.model_used,
          result.tokens_used.input,
          result.tokens_used.output,
          result.cost_usd,
          result.execution_time_ms,
          result.validation_passed,
          result.retry_count,
          JSON.stringify(result.output),
          null, // error field for failed executions
          result.created_at
        ]
      );
    } catch (error) {
      console.error('Error recording prompt execution:', error);
      // Don't throw - lifecycle tracking shouldn't break the main flow
    }
  }

  /**
   * Get execution history for an intent
   */
  async getInstanceHistory(intentName: string, limit = 10): Promise<any[]> {
    try {
      const result = await this.pool.query(
        `SELECT
          pi.instance_id,
          pi.intent_name,
          pi.template_id,
          pi.template_version,
          pi.assembled_at,
          pe.execution_id,
          pe.model_used,
          pe.tokens_input,
          pe.tokens_output,
          pe.cost_usd,
          pe.execution_time_ms,
          pe.validation_passed,
          pe.retry_count,
          pe.executed_at
        FROM prompt_instances pi
        LEFT JOIN prompt_executions pe ON pi.instance_id = pe.instance_id
        WHERE pi.intent_name = $1
        ORDER BY pi.assembled_at DESC, pe.executed_at DESC
        LIMIT $2`,
        [intentName, limit]
      );

      return result.rows;
    } catch (error) {
      console.error('Error getting instance history:', error);
      return [];
    }
  }

  /**
   * Get prompt metrics for an intent
   */
  async getMetrics(intentName: string, days = 7): Promise<any> {
    try {
      const result = await this.pool.query(
        `SELECT * FROM get_prompt_metrics($1, $2)`,
        [intentName, days]
      );

      return result.rows[0] || {
        total_executions: 0,
        avg_tokens_input: 0,
        avg_tokens_output: 0,
        total_cost_usd: 0,
        avg_execution_time_ms: 0,
        validation_success_rate: 0
      };
    } catch (error) {
      console.error('Error getting prompt metrics:', error);
      return null;
    }
  }

  /**
   * Get performance comparison across templates
   */
  async getTemplatePerformance(): Promise<any[]> {
    try {
      const result = await this.pool.query(
        `SELECT * FROM prompt_performance
         WHERE execution_count > 0
         ORDER BY total_cost DESC
         LIMIT 20`
      );

      return result.rows;
    } catch (error) {
      console.error('Error getting template performance:', error);
      return [];
    }
  }

  /**
   * Get retry analysis
   */
  async getRetryAnalysis(days = 7): Promise<any[]> {
    try {
      const result = await this.pool.query(
        `SELECT
          pi.intent_name,
          pe.retry_count,
          COUNT(*) as occurrences,
          AVG(pe.cost_usd) as avg_cost,
          AVG(pe.execution_time_ms) as avg_latency_ms
        FROM prompt_executions pe
        JOIN prompt_instances pi ON pe.instance_id = pi.instance_id
        WHERE pe.executed_at >= NOW() - $1::INTERVAL
          AND pe.retry_count > 0
        GROUP BY pi.intent_name, pe.retry_count
        ORDER BY pi.intent_name, pe.retry_count`,
        [`${days} days`]
      );

      return result.rows;
    } catch (error) {
      console.error('Error getting retry analysis:', error);
      return [];
    }
  }
}
