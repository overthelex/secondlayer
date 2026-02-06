import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';
import {
  CostEstimate,
  CostBreakdown,
  OpenAICallRecord,
  ZOCallRecord,
  SecondLayerCallRecord,
} from '../types/cost.js';
import { BillingService } from './billing-service.js';

export class CostTracker {
  private billingService?: BillingService;

  constructor(private db: Database) {}

  /**
   * Set billing service for automatic charging
   */
  setBillingService(billingService: BillingService): void {
    this.billingService = billingService;
    logger.info('BillingService connected to CostTracker');
  }

  /**
   * ZakonOnline pricing tiers (USD)
   * Returns cost per API call in USD based on monthly total
   */
  private calculateZOCostPerCall(monthlyTotal: number): number {
    if (monthlyTotal < 10000) {
      return 0.00714; // $0.00714 per call (fixed monthly fee amortized)
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
   * Get current monthly ZO API call count from database
   */
  async getMonthlyZOCallCount(): Promise<number> {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const result = await this.db.query(
      'SELECT zakononline_total_calls FROM monthly_api_usage WHERE year_month = $1',
      [yearMonth]
    );

    return result.rows[0]?.zakononline_total_calls || 0;
  }

  /**
   * Create a new tracking record with status pending
   */
  async createTrackingRecord(params: {
    requestId: string;
    toolName: string;
    clientKey?: string;
    userId?: string;
    userQuery: string;
    queryParams: any;
  }): Promise<void> {
    const monthlyTotal = await this.getMonthlyZOCallCount();

    await this.db.query(
      `INSERT INTO cost_tracking (
        request_id, tool_name, client_key, user_id, user_query, query_params,
        zakononline_monthly_total, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        params.requestId,
        params.toolName,
        params.clientKey || null,
        params.userId || null,
        params.userQuery,
        JSON.stringify(params.queryParams),
        monthlyTotal,
        'pending',
      ]
    );

    logger.debug('Cost tracking record created', {
      requestId: params.requestId,
      userId: params.userId,
      clientKey: params.clientKey ? params.clientKey.substring(0, 8) + '...' : 'none',
    });
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
      // Don't throw - we don't want to interrupt the main request
    }
  }

  /**
   * Record a ZakonOnline API call (only if not cached)
   */
  async recordZOCall(params: {
    requestId: string;
    endpoint: string;
    cached: boolean;
  }): Promise<void> {
    // Don't count cached requests
    if (params.cached) {
      logger.debug('Skipping cached ZO call', {
        requestId: params.requestId,
        endpoint: params.endpoint,
      });
      return;
    }

    const monthlyTotal = await this.getMonthlyZOCallCount();
    const costPerCall = this.calculateZOCostPerCall(monthlyTotal);

    const callRecord: ZOCallRecord = {
      endpoint: params.endpoint,
      timestamp: new Date().toISOString(),
      cached: params.cached,
    };

    try {
      await this.db.query(
        `UPDATE cost_tracking
         SET zakononline_api_calls = zakononline_api_calls + 1,
             zakononline_cost_usd = zakononline_cost_usd + $1,
             zakononline_calls = zakononline_calls || $2::jsonb
         WHERE request_id = $3`,
        [costPerCall, JSON.stringify([callRecord]), params.requestId]
      );

      // Update monthly statistics
      const now = new Date();
      const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

      await this.db.query(
        `INSERT INTO monthly_api_usage (year_month, zakononline_total_calls, zakononline_total_cost_usd)
         VALUES ($1, 1, $2)
         ON CONFLICT (year_month) DO UPDATE
         SET zakononline_total_calls = monthly_api_usage.zakononline_total_calls + 1,
             zakononline_total_cost_usd = monthly_api_usage.zakononline_total_cost_usd + $2,
             updated_at = NOW()`,
        [yearMonth, costPerCall]
      );

      logger.debug('ZO API call recorded', {
        requestId: params.requestId,
        endpoint: params.endpoint,
        cost: `$${costPerCall.toFixed(6)}`,
      });
    } catch (error) {
      logger.error('Failed to record ZO call:', error);
      // Don't throw - we don't want to interrupt the main request
    }
  }

  /**
   * SecondLayer MCP pricing tiers (same as ZakonOnline)
   * Returns cost per API call in USD based on monthly total
   */
  private calculateSecondLayerCostPerCall(monthlyTotal: number): number {
    // Same tiers as ZakonOnline (USD)
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
   * Get current monthly SecondLayer API call count from database
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
   * Record cost from a remote MCP service call (RADA, OpenReyestr)
   * Used by gateway to aggregate costs from proxied requests
   */
  async recordRemoteServiceCall(params: {
    requestId: string;
    service: 'rada' | 'openreyestr';
    toolName: string;
    costUsd: number;
    details: any;
  }): Promise<void> {
    const { requestId, service, toolName, costUsd, details } = params;

    try {
      await this.db.query(
        `UPDATE cost_tracking
         SET secondlayer_cost_usd = secondlayer_cost_usd + $1,
             total_cost_usd = total_cost_usd + $1,
             secondlayer_calls = COALESCE(secondlayer_calls, '[]'::jsonb) || $2::jsonb
         WHERE request_id = $3`,
        [
          costUsd,
          JSON.stringify([
            {
              service,
              tool_name: toolName,
              cost_usd: costUsd,
              timestamp: new Date().toISOString(),
              details,
            },
          ]),
          requestId,
        ]
      );

      logger.debug('Remote service cost recorded in gateway', {
        requestId,
        service,
        toolName,
        costUsd: costUsd.toFixed(6),
      });
    } catch (error) {
      logger.error('Failed to record remote service cost:', error);
      // Don't throw - we don't want to interrupt the main request
    }
  }

  /**
   * Record a SecondLayer MCP API call (web scraping, processing, etc.)
   * Only counts non-cached operations
   */
  async recordSecondLayerCall(params: {
    requestId: string;
    operation: string;
    docId?: string | number;
    cached: boolean;
  }): Promise<void> {
    // Don't count cached requests
    if (params.cached) {
      logger.debug('Skipping cached SecondLayer call', {
        requestId: params.requestId,
        operation: params.operation,
      });
      return;
    }

    const monthlyTotal = await this.getMonthlySecondLayerCallCount();
    const costPerCall = this.calculateSecondLayerCostPerCall(monthlyTotal);

    const callRecord: SecondLayerCallRecord = {
      operation: params.operation,
      doc_id: params.docId,
      timestamp: new Date().toISOString(),
      cached: params.cached,
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
        operation: params.operation,
        cost: `$${costPerCall.toFixed(6)}`,
      });
    } catch (error) {
      logger.error('Failed to record SecondLayer call:', error);
      // Don't throw - we don't want to interrupt the main request
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

    // Base estimates based on budget
    let estimatedTokens = 0;
    let estimatedZOCalls = 0;

    switch (params.reasoningBudget) {
      case 'quick':
        estimatedTokens = 1000; // intent classification
        estimatedZOCalls = 1; // one search
        break;
      case 'standard':
        estimatedTokens = 3000; // intent + embeddings
        estimatedZOCalls = 2; // search + possible additional requests
        break;
      case 'deep':
        estimatedTokens = 5000; // intent + embeddings + deep analysis
        estimatedZOCalls = 5; // multiple requests
        break;
    }

    // Account for query length (~4 chars per token)
    estimatedTokens += Math.floor(params.queryLength / 4);

    // Tool-specific adjustments
    if (params.toolName === 'get_legal_advice') {
      estimatedZOCalls += 3; // additional requests for full analysis
      estimatedTokens += 2000; // embeddings for sections
      notes.push('Full legal analysis includes multiple sub-queries');
    } else if (params.toolName === 'search_legal_precedents') {
      estimatedZOCalls += 1;
      notes.push('Basic precedent search');
    } else if (params.toolName.includes('search')) {
      estimatedZOCalls += 1;
      notes.push('Search operation');
    }

    // Get current ZO tier
    const monthlyZOTotal = await this.getMonthlyZOCallCount();
    const zoCostPerCall = this.calculateZOCostPerCall(monthlyZOTotal);
    const zoEstimatedCost = estimatedZOCalls * zoCostPerCall;

    // Estimate SecondLayer MCP calls (web scraping = 5-10 docs per search on average)
    let estimatedSecondLayerCalls = 0;
    if (params.toolName === 'search_legal_precedents' || params.toolName.includes('search')) {
      estimatedSecondLayerCalls = 5; // average docs loaded per search
    } else if (params.toolName === 'get_legal_advice') {
      estimatedSecondLayerCalls = 10; // full analysis loads more documents
    }

    const monthlySecondLayerTotal = await this.getMonthlySecondLayerCallCount();
    const secondLayerCostPerCall = this.calculateSecondLayerCostPerCall(monthlySecondLayerTotal);
    const secondLayerEstimatedCost = estimatedSecondLayerCalls * secondLayerCostPerCall;

    // Estimate OpenAI cost (using averaged cost per 1k tokens)
    const avgCostPer1kTokens = 0.002; // averaged cost across models
    const openaiEstimatedCost = (estimatedTokens / 1000) * avgCostPer1kTokens;

    const totalUsd = openaiEstimatedCost + zoEstimatedCost + secondLayerEstimatedCost;

    return {
      openai_estimated_tokens: estimatedTokens,
      openai_estimated_cost_usd: openaiEstimatedCost,
      zakononline_estimated_calls: estimatedZOCalls,
      zakononline_estimated_cost_usd: zoEstimatedCost,
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

    // Calculate total costs (convert DECIMAL strings to numbers)
    const openaiCostUsd = Number(record.openai_cost_usd);
    const zakononlineCostUsd = Number(record.zakononline_cost_usd);
    const secondlayerCostUsd = Number(record.secondlayer_cost_usd || 0);

    const totalCostUsd = openaiCostUsd + zakononlineCostUsd + secondlayerCostUsd;

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
    const zoMonthlyTotal = record.zakononline_monthly_total || 0;
    const zoCurrentTier = this.getTierName(zoMonthlyTotal);
    const zoNextTierAt = this.getNextTierThreshold(zoMonthlyTotal);

    const slMonthlyTotal = record.secondlayer_monthly_total || 0;
    const slCurrentTier = this.getTierName(slMonthlyTotal); // Same tier names as ZO
    const slNextTierAt = this.getNextTierThreshold(slMonthlyTotal);

    const breakdown: CostBreakdown = {
      request_id: params.requestId,
      openai: {
        total_tokens: record.openai_total_tokens,
        prompt_tokens: record.openai_prompt_tokens,
        completion_tokens: record.openai_completion_tokens,
        total_cost_usd: openaiCostUsd,
        calls: record.openai_calls || [],
      },
      zakononline: {
        total_calls: record.zakononline_api_calls,
        monthly_total_before: zoMonthlyTotal,
        monthly_total_after: zoMonthlyTotal + record.zakononline_api_calls,
        total_cost_usd: zakononlineCostUsd,
        current_tier: zoCurrentTier,
        next_tier_at: zoNextTierAt,
        calls: record.zakononline_calls || [],
      },
      secondlayer: {
        total_calls: record.secondlayer_api_calls || 0,
        monthly_total_before: slMonthlyTotal,
        monthly_total_after: slMonthlyTotal + (record.secondlayer_api_calls || 0),
        total_cost_usd: secondlayerCostUsd,
        current_tier: slCurrentTier,
        next_tier_at: slNextTierAt,
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
      userId: record.user_id || 'none',
    });

    // Automatically charge user if billing service is configured and request was completed
    if (this.billingService && record.user_id && params.status === 'completed' && totalCostUsd > 0) {
      try {
        await this.billingService.chargeUser({
          userId: record.user_id,
          requestId: params.requestId,
          amountUsd: totalCostUsd,
          description: `${record.tool_name}: ${record.user_query?.substring(0, 100) || 'N/A'}`,
        });
        logger.debug('User automatically charged', {
          requestId: params.requestId,
          userId: record.user_id,
          amount: totalCostUsd.toFixed(6),
        });
      } catch (error: any) {
        // Don't fail the request if billing fails
        logger.error('Failed to charge user automatically', {
          requestId: params.requestId,
          userId: record.user_id,
          error: error.message,
        });
      }
    }

    return breakdown;
  }

  private getTierName(monthlyTotal: number): string {
    if (monthlyTotal < 10000) return 'Tier 1: 0-10,000 ($0.00714/call)';
    if (monthlyTotal < 20000) return 'Tier 2: 10,001-20,000 ($0.00690/call)';
    if (monthlyTotal < 30000) return 'Tier 3: 20,001-30,000 ($0.00667/call)';
    if (monthlyTotal < 50000) return 'Tier 4: 30,001-50,000 ($0.00643/call)';
    return 'Tier 5: 50,001+ ($0.00238/call)';
  }

  private getNextTierThreshold(monthlyTotal: number): number {
    if (monthlyTotal < 10000) return 10000;
    if (monthlyTotal < 20000) return 20000;
    if (monthlyTotal < 30000) return 30000;
    if (monthlyTotal < 50000) return 50000;
    return -1; // maximum tier
  }
}
