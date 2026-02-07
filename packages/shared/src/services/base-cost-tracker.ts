import { BaseDatabase } from '../database/base-database';
import { logger } from '../utils/logger';
import {
  CostEstimate,
  CostBreakdown,
  OpenAICallRecord,
  AnthropicCallRecord,
} from '../types/cost';

export interface CostTrackerConfig {
  enableOpenAI?: boolean;
  enableAnthropic?: boolean;
  enableZakonOnline?: boolean;
  enableRadaAPI?: boolean;
  enableDatabase?: boolean;
  enableSecondLayer?: boolean;
}

export interface AdditionalCostResult {
  additionalCostUsd: number;
  additionalBreakdownSections: Partial<CostBreakdown>;
}

export abstract class BaseCostTracker {
  protected config: CostTrackerConfig;

  constructor(
    protected db: BaseDatabase,
    config: CostTrackerConfig = {}
  ) {
    this.config = {
      enableOpenAI: true,
      enableAnthropic: false,
      enableZakonOnline: false,
      enableRadaAPI: false,
      enableDatabase: false,
      enableSecondLayer: true,
      ...config,
    };
  }

  protected calculateSecondLayerCostPerCall(monthlyTotal: number): number {
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

  async getMonthlySecondLayerCallCount(): Promise<number> {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const result = await this.db.query(
      'SELECT secondlayer_total_calls FROM monthly_api_usage WHERE year_month = $1',
      [yearMonth]
    );

    return result.rows[0]?.secondlayer_total_calls || 0;
  }

  async createTrackingRecord(params: {
    requestId: string;
    toolName: string;
    clientKey?: string;
    userId?: string;
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
        params.clientKey || null,
        params.userQuery,
        JSON.stringify(params.queryParams),
        'pending',
      ]
    );

    logger.debug('Cost tracking record created', { requestId: params.requestId });
  }

  async recordOpenAICall(params: {
    requestId: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
    task: string;
  }): Promise<void> {
    if (!this.config.enableOpenAI) return;

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

  async recordAnthropicCall(params: {
    requestId: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
    task: string;
  }): Promise<void> {
    if (!this.config.enableAnthropic) return;

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

  async recordSecondLayerCall(params: {
    requestId: string;
    operation?: string;
    toolName?: string;
    docId?: string | number;
    cached?: boolean;
  }): Promise<void> {
    if (!this.config.enableSecondLayer) return;

    if (params.cached) {
      logger.debug('Skipping cached SecondLayer call', {
        requestId: params.requestId,
        operation: params.operation,
      });
      return;
    }

    const monthlyTotal = await this.getMonthlySecondLayerCallCount();
    const costPerCall = this.calculateSecondLayerCostPerCall(monthlyTotal);

    const callRecord = {
      operation: params.operation,
      tool_name: params.toolName,
      doc_id: params.docId,
      timestamp: new Date().toISOString(),
      cached: params.cached || false,
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
        operation: params.operation || params.toolName,
        cost: `$${costPerCall.toFixed(6)}`,
      });
    } catch (error) {
      logger.error('Failed to record SecondLayer call:', error);
    }
  }

  abstract estimateCost(params: {
    toolName: string;
    queryLength: number;
    reasoningBudget: 'quick' | 'standard' | 'deep';
  }): Promise<CostEstimate>;

  /**
   * Hook: return server-specific additional costs (e.g. zakononline, rada_api, database).
   * Default returns 0 additional cost.
   */
  protected async calculateAdditionalCosts(_record: any): Promise<AdditionalCostResult> {
    return { additionalCostUsd: 0, additionalBreakdownSections: {} };
  }

  /**
   * Hook: post-processing after tracking is complete (e.g. billing charges).
   * Default is a no-op.
   */
  protected async onTrackingComplete(
    _record: any,
    _breakdown: CostBreakdown,
    _totalCostUsd: number,
    _status: 'completed' | 'failed'
  ): Promise<void> {
    // no-op by default
  }

  async completeTrackingRecord(params: {
    requestId: string;
    executionTimeMs: number;
    status: 'completed' | 'failed';
    errorMessage?: string;
  }): Promise<CostBreakdown> {
    const result = await this.db.query('SELECT * FROM cost_tracking WHERE request_id = $1', [
      params.requestId,
    ]);

    if (result.rows.length === 0) {
      throw new Error(`Tracking record not found: ${params.requestId}`);
    }

    const record = result.rows[0];

    const openaiCostUsd = Number(record.openai_cost_usd || 0);
    const anthropicCostUsd = Number(record.anthropic_cost_usd || 0);
    const secondlayerCostUsd = Number(record.secondlayer_cost_usd || 0);

    // Get server-specific additional costs
    const { additionalCostUsd, additionalBreakdownSections } =
      await this.calculateAdditionalCosts(record);

    const totalCostUsd = openaiCostUsd + anthropicCostUsd + secondlayerCostUsd + additionalCostUsd;

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

    const breakdown: CostBreakdown = {
      request_id: params.requestId,
      openai: {
        total_tokens: record.openai_total_tokens || 0,
        prompt_tokens: record.openai_prompt_tokens || 0,
        completion_tokens: record.openai_completion_tokens || 0,
        total_cost_usd: openaiCostUsd,
        calls: record.openai_calls || [],
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
      // Merge server-specific breakdown sections
      ...additionalBreakdownSections,
    };

    // Add anthropic section if enabled and data exists
    if (this.config.enableAnthropic || Number(record.anthropic_cost_usd || 0) > 0) {
      breakdown.anthropic = {
        total_tokens: record.anthropic_total_tokens || 0,
        prompt_tokens: record.anthropic_prompt_tokens || 0,
        completion_tokens: record.anthropic_completion_tokens || 0,
        total_cost_usd: anthropicCostUsd,
        calls: record.anthropic_calls || [],
      };
    }

    logger.info('Cost tracking completed', {
      requestId: params.requestId,
      status: params.status,
      totalCostUsd: totalCostUsd.toFixed(6),
    });

    // Post-processing hook (e.g. billing)
    await this.onTrackingComplete(record, breakdown, totalCostUsd, params.status);

    return breakdown;
  }

  protected getTierName(monthlyTotal: number): string {
    if (monthlyTotal < 10000) return 'Tier 1: 0-10,000 ($0.00714/call)';
    if (monthlyTotal < 20000) return 'Tier 2: 10,001-20,000 ($0.00690/call)';
    if (monthlyTotal < 30000) return 'Tier 3: 20,001-30,000 ($0.00667/call)';
    if (monthlyTotal < 50000) return 'Tier 4: 30,001-50,000 ($0.00643/call)';
    return 'Tier 5: 50,001+ ($0.00238/call)';
  }

  protected getNextTierThreshold(monthlyTotal: number): number {
    if (monthlyTotal < 10000) return 10000;
    if (monthlyTotal < 20000) return 20000;
    if (monthlyTotal < 30000) return 30000;
    if (monthlyTotal < 50000) return 50000;
    return -1;
  }
}
