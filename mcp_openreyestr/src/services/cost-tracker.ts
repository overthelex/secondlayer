import { Database } from '../database/database';
import { logger } from '../utils/logger';
import {
  CostEstimate,
  CostBreakdown,
  OpenAICallRecord,
  AnthropicCallRecord,
  SecondLayerCallRecord,
  DatabaseQueryRecord,
} from '../types/cost';

export class CostTracker {
  constructor(private db: Database) {}

  /**
   * SecondLayer MCP pricing tiers (USD)
   * Returns cost per API call in USD based on monthly total
   */
  private calculateSecondLayerCostPerCall(monthlyTotal: number): number {
    if (monthlyTotal < 10000) {
      return 0.00714;
    } else if (monthlyTotal < 20000) {
      return 0.00690;
    } else if (monthlyTotal < 30000) {
      return 0.00667;
    } else if (monthlyTotal < 50000) {
      return 0.00643;
    } else {
      return 0.00238;
    }
  }

  /**
   * Get current monthly SecondLayer API call count
   */
  async getMonthlySecondLayerCallCount(): Promise<number> {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const result = await this.db.query(
      'SELECT secondlayer_total_calls FROM monthly_api_usage WHERE year_month = $1',
      [yearMonth]
    );

    return result.rows[0]?.secondlayer_total_calls || 0;
  }

  /**
   * Create a new tracking record with status pending
   */
  async createTrackingRecord(params: {
    requestId: string;
    toolName: string;
    clientKey: string;
    userQuery: string;
    queryParams: any;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO cost_tracking (
        request_id, tool_name, client_key, user_query, query_params, status
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        params.requestId,
        params.toolName,
        params.clientKey,
        params.userQuery,
        JSON.stringify(params.queryParams),
        'pending',
      ]
    );

    logger.debug('Cost tracking record created', { requestId: params.requestId });
  }

  /**
   * Record an OpenAI API call with actual usage from response.usage
   */
  async recordOpenAICall(params: {
    requestId: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
    task: string;
  }): Promise<void> {
    const callRecord: OpenAICallRecord = {
      model: params.model,
      prompt_tokens: params.promptTokens,
      completion_tokens: params.completionTokens,
      total_tokens: params.totalTokens,
      cost_usd: params.costUsd,
      task: params.task,
      timestamp: new Date().toISOString(),
    };

    try {
      await this.db.query(
        `UPDATE cost_tracking
         SET openai_total_tokens = openai_total_tokens + $1,
             openai_prompt_tokens = openai_prompt_tokens + $2,
             openai_completion_tokens = openai_completion_tokens + $3,
             openai_cost_usd = openai_cost_usd + $4,
             openai_calls = openai_calls || $5::jsonb
         WHERE request_id = $6`,
        [
          params.totalTokens,
          params.promptTokens,
          params.completionTokens,
          params.costUsd,
          JSON.stringify([callRecord]),
          params.requestId,
        ]
      );

      logger.debug('OpenAI call recorded', {
        requestId: params.requestId,
        model: params.model,
        tokens: params.totalTokens,
        cost: `$${params.costUsd.toFixed(6)}`,
      });
    } catch (error) {
      logger.error('Failed to record OpenAI call:', error);
    }
  }

  /**
   * Record an Anthropic API call
   */
  async recordAnthropicCall(params: {
    requestId: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
    task: string;
  }): Promise<void> {
    const callRecord: AnthropicCallRecord = {
      model: params.model,
      prompt_tokens: params.promptTokens,
      completion_tokens: params.completionTokens,
      total_tokens: params.totalTokens,
      cost_usd: params.costUsd,
      task: params.task,
      timestamp: new Date().toISOString(),
    };

    try {
      await this.db.query(
        `UPDATE cost_tracking
         SET anthropic_total_tokens = anthropic_total_tokens + $1,
             anthropic_prompt_tokens = anthropic_prompt_tokens + $2,
             anthropic_completion_tokens = anthropic_completion_tokens + $3,
             anthropic_cost_usd = anthropic_cost_usd + $4,
             anthropic_calls = anthropic_calls || $5::jsonb
         WHERE request_id = $6`,
        [
          params.totalTokens,
          params.promptTokens,
          params.completionTokens,
          params.costUsd,
          JSON.stringify([callRecord]),
          params.requestId,
        ]
      );

      logger.debug('Anthropic call recorded', {
        requestId: params.requestId,
        model: params.model,
        tokens: params.totalTokens,
        cost: `$${params.costUsd.toFixed(6)}`,
      });
    } catch (error) {
      logger.error('Failed to record Anthropic call:', error);
    }
  }

  /**
   * Record a database query (FREE but track usage for monitoring)
   */
  async recordDatabaseQuery(params: {
    requestId: string;
    queryType: 'search' | 'details' | 'beneficiaries' | 'edrpou' | 'stats';
    executionTimeMs: number;
    rowsReturned: number;
  }): Promise<void> {
    const queryRecord: DatabaseQueryRecord = {
      query_type: params.queryType,
      execution_time_ms: params.executionTimeMs,
      rows_returned: params.rowsReturned,
      timestamp: new Date().toISOString(),
    };

    try {
      await this.db.query(
        `UPDATE cost_tracking
         SET database_queries_count = database_queries_count + 1,
             database_total_rows = database_total_rows + $1,
             database_calls = database_calls || $2::jsonb
         WHERE request_id = $3`,
        [params.rowsReturned, JSON.stringify([queryRecord]), params.requestId]
      );

      logger.debug('Database query recorded', {
        requestId: params.requestId,
        queryType: params.queryType,
        rows: params.rowsReturned,
        executionTime: `${params.executionTimeMs}ms`,
      });
    } catch (error) {
      logger.error('Failed to record database query:', error);
    }
  }

  /**
   * Record a SecondLayer API call (cross-referencing with court cases)
   */
  async recordSecondLayerCall(params: {
    requestId: string;
    toolName: string;
  }): Promise<void> {
    const monthlyTotal = await this.getMonthlySecondLayerCallCount();
    const costPerCall = this.calculateSecondLayerCostPerCall(monthlyTotal);

    const callRecord: SecondLayerCallRecord = {
      tool_name: params.toolName,
      timestamp: new Date().toISOString(),
      cost_usd: costPerCall,
    };

    try {
      await this.db.query(
        `UPDATE cost_tracking
         SET secondlayer_api_calls = secondlayer_api_calls + 1,
             secondlayer_cost_usd = secondlayer_cost_usd + $1,
             secondlayer_calls = secondlayer_calls || $2::jsonb
         WHERE request_id = $3`,
        [costPerCall, JSON.stringify([callRecord]), params.requestId]
      );

      // Update monthly statistics
      const now = new Date();
      const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

      await this.db.query(
        `INSERT INTO monthly_api_usage (year_month, secondlayer_total_calls, secondlayer_total_cost_usd)
         VALUES ($1, 1, $2)
         ON CONFLICT (year_month) DO UPDATE
         SET secondlayer_total_calls = monthly_api_usage.secondlayer_total_calls + 1,
             secondlayer_total_cost_usd = monthly_api_usage.secondlayer_total_cost_usd + $2,
             updated_at = NOW()`,
        [yearMonth, costPerCall]
      );

      logger.debug('SecondLayer API call recorded', {
        requestId: params.requestId,
        toolName: params.toolName,
        cost: `$${costPerCall.toFixed(6)}`,
      });
    } catch (error) {
      logger.error('Failed to record SecondLayer call:', error);
    }
  }

  /**
   * Estimate cost BEFORE execution (heuristics-based)
   */
  async estimateCost(params: {
    toolName: string;
    queryLength: number;
    reasoningBudget: 'quick' | 'standard' | 'deep';
  }): Promise<CostEstimate> {
    const notes: string[] = [];

    // Base estimates based on budget (if AI analysis is used)
    let estimatedTokens = 0;
    let estimatedDbQueries = 1; // Most tools do at least 1 DB query

    switch (params.reasoningBudget) {
      case 'quick':
        estimatedTokens = 500; // Simple analysis
        break;
      case 'standard':
        estimatedTokens = 1500;
        break;
      case 'deep':
        estimatedTokens = 3000;
        estimatedDbQueries += 2; // Deep analysis may need additional queries
        break;
    }

    // Tool-specific adjustments
    if (params.toolName === 'get_entity_details') {
      estimatedDbQueries += 8; // Gets related data (founders, beneficiaries, etc.)
      notes.push('Retrieves entity with all related data (founders, beneficiaries, branches, etc.)');
    } else if (params.toolName === 'search_entities') {
      notes.push('Searches entities across all types (UO, FOP, FSU)');
      if (params.queryLength > 50) {
        estimatedDbQueries += 1; // Complex search may need more queries
      }
    } else if (params.toolName === 'search_beneficiaries') {
      estimatedDbQueries += 1; // Joins with entity tables
      notes.push('Searches beneficiaries with entity lookups');
    }

    // Estimate SecondLayer calls (if cross-referencing with court cases)
    let estimatedSecondLayerCalls = 0;
    // OpenReyestr typically doesn't need SecondLayer cross-referencing by default
    // but can be added for specific use cases

    const monthlySecondLayerTotal = await this.getMonthlySecondLayerCallCount();
    const secondLayerCostPerCall = this.calculateSecondLayerCostPerCall(monthlySecondLayerTotal);
    const secondLayerEstimatedCost = estimatedSecondLayerCalls * secondLayerCostPerCall;

    // Estimate OpenAI cost (if AI features are enabled)
    const avgCostPer1kTokens = 0.002; // Average for gpt-4o-mini
    const openaiEstimatedCost = (estimatedTokens / 1000) * avgCostPer1kTokens;

    const totalUsd = openaiEstimatedCost + secondLayerEstimatedCost;

    return {
      openai_estimated_tokens: estimatedTokens,
      openai_estimated_cost_usd: openaiEstimatedCost,
      anthropic_estimated_tokens: 0,
      anthropic_estimated_cost_usd: 0,
      database_estimated_queries: estimatedDbQueries,
      secondlayer_estimated_calls: estimatedSecondLayerCalls,
      secondlayer_estimated_cost_usd: secondLayerEstimatedCost,
      total_estimated_cost_usd: totalUsd,
      estimation_notes: notes,
    };
  }

  /**
   * Complete tracking record and calculate final cost breakdown
   */
  async completeTrackingRecord(params: {
    requestId: string;
    executionTimeMs: number;
    status: 'completed' | 'failed';
    errorMessage?: string;
  }): Promise<CostBreakdown> {
    // Get current tracking record
    const result = await this.db.query('SELECT * FROM cost_tracking WHERE request_id = $1', [
      params.requestId,
    ]);

    if (result.rows.length === 0) {
      throw new Error(`Tracking record not found: ${params.requestId}`);
    }

    const record = result.rows[0];

    // Calculate total costs
    const openaiCostUsd = Number(record.openai_cost_usd || 0);
    const anthropicCostUsd = Number(record.anthropic_cost_usd || 0);
    const secondlayerCostUsd = Number(record.secondlayer_cost_usd || 0);

    const totalCostUsd = openaiCostUsd + anthropicCostUsd + secondlayerCostUsd;

    // Update record with final costs
    await this.db.query(
      `UPDATE cost_tracking
       SET total_cost_usd = $1,
           execution_time_ms = $2,
           status = $3,
           error_message = $4,
           completed_at = NOW()
       WHERE request_id = $5`,
      [totalCostUsd, params.executionTimeMs, params.status, params.errorMessage || null, params.requestId]
    );

    // Build breakdown response
    const breakdown: CostBreakdown = {
      request_id: params.requestId,
      openai: {
        total_tokens: record.openai_total_tokens || 0,
        prompt_tokens: record.openai_prompt_tokens || 0,
        completion_tokens: record.openai_completion_tokens || 0,
        total_cost_usd: openaiCostUsd,
        calls: record.openai_calls || [],
      },
      anthropic: {
        total_tokens: record.anthropic_total_tokens || 0,
        prompt_tokens: record.anthropic_prompt_tokens || 0,
        completion_tokens: record.anthropic_completion_tokens || 0,
        total_cost_usd: anthropicCostUsd,
        calls: record.anthropic_calls || [],
      },
      database: {
        total_queries: record.database_queries_count || 0,
        total_rows: record.database_total_rows || 0,
        calls: record.database_calls || [],
      },
      secondlayer: {
        total_calls: record.secondlayer_api_calls || 0,
        total_cost_usd: secondlayerCostUsd,
        calls: record.secondlayer_calls || [],
      },
      totals: {
        cost_usd: totalCostUsd,
        execution_time_ms: params.executionTimeMs,
      },
    };

    logger.info('Cost tracking completed', {
      requestId: params.requestId,
      status: params.status,
      totalCostUsd: totalCostUsd.toFixed(6),
    });

    return breakdown;
  }
}
