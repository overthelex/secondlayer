import { BaseCostTracker, AdditionalCostResult } from '@secondlayer/shared';
import { CostEstimate, CostBreakdown, ZOCallRecord } from '@secondlayer/shared';
import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';
import { BillingService } from './billing-service.js';

export class CostTracker extends BaseCostTracker {
  private billingService?: BillingService;
  private metricsCallback?: (toolName: string, costUsd: number) => void;

  constructor(db: Database) {
    super(db, {
      enableOpenAI: true,
      enableZakonOnline: true,
      enableSecondLayer: true,
    });
  }

  setBillingService(billingService: BillingService): void {
    this.billingService = billingService;
    logger.info('BillingService connected to CostTracker');
  }

  /**
   * Register a callback to increment Prometheus cost counter on tracking completion.
   */
  setMetricsCallback(callback: (toolName: string, costUsd: number) => void): void {
    this.metricsCallback = callback;
  }

  private calculateZOCostPerCall(monthlyTotal: number): number {
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

  async getMonthlyZOCallCount(): Promise<number> {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const result = await this.db.query(
      'SELECT zakononline_total_calls FROM monthly_api_usage WHERE year_month = $1',
      [yearMonth]
    );

    return result.rows[0]?.zakononline_total_calls || 0;
  }

  override async createTrackingRecord(params: {
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

  async recordZOCall(params: {
    requestId: string;
    endpoint: string;
    cached: boolean;
  }): Promise<void> {
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
    }
  }

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
    }
  }

  async estimateCost(params: {
    toolName: string;
    queryLength: number;
    reasoningBudget: 'quick' | 'standard' | 'deep';
  }): Promise<CostEstimate> {
    const notes: string[] = [];
    let estimatedTokens = 0;
    let estimatedZOCalls = 0;

    switch (params.reasoningBudget) {
      case 'quick':
        estimatedTokens = 1000;
        estimatedZOCalls = 1;
        break;
      case 'standard':
        estimatedTokens = 3000;
        estimatedZOCalls = 2;
        break;
      case 'deep':
        estimatedTokens = 5000;
        estimatedZOCalls = 5;
        break;
    }

    estimatedTokens += Math.floor(params.queryLength / 4);

    if (params.toolName === 'search_legal_precedents') {
      estimatedZOCalls += 1;
      notes.push('Basic precedent search');
    } else if (params.toolName.includes('search')) {
      estimatedZOCalls += 1;
      notes.push('Search operation');
    }

    const monthlyZOTotal = await this.getMonthlyZOCallCount();
    const zoCostPerCall = this.calculateZOCostPerCall(monthlyZOTotal);
    const zoEstimatedCost = estimatedZOCalls * zoCostPerCall;

    let estimatedSecondLayerCalls = 0;
    if (params.toolName === 'search_legal_precedents' || params.toolName.includes('search')) {
      estimatedSecondLayerCalls = 5;
    }

    const monthlySecondLayerTotal = await this.getMonthlySecondLayerCallCount();
    const secondLayerCostPerCall = this.calculateSecondLayerCostPerCall(monthlySecondLayerTotal);
    const secondLayerEstimatedCost = estimatedSecondLayerCalls * secondLayerCostPerCall;

    const avgCostPer1kTokens = 0.002;
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

  protected override async calculateAdditionalCosts(record: any): Promise<AdditionalCostResult> {
    const zakononlineCostUsd = Number(record.zakononline_cost_usd || 0);
    const zoMonthlyTotal = record.zakononline_monthly_total || 0;

    return {
      additionalCostUsd: zakononlineCostUsd,
      additionalBreakdownSections: {
        zakononline: {
          total_calls: record.zakononline_api_calls || 0,
          monthly_total_before: zoMonthlyTotal,
          monthly_total_after: zoMonthlyTotal + (record.zakononline_api_calls || 0),
          total_cost_usd: zakononlineCostUsd,
          current_tier: this.getTierName(zoMonthlyTotal),
          next_tier_at: this.getNextTierThreshold(zoMonthlyTotal),
          calls: record.zakononline_calls || [],
        },
        secondlayer: {
          total_calls: record.secondlayer_api_calls || 0,
          monthly_total_before: record.secondlayer_monthly_total || 0,
          monthly_total_after: (record.secondlayer_monthly_total || 0) + (record.secondlayer_api_calls || 0),
          total_cost_usd: Number(record.secondlayer_cost_usd || 0),
          current_tier: this.getTierName(record.secondlayer_monthly_total || 0),
          next_tier_at: this.getNextTierThreshold(record.secondlayer_monthly_total || 0),
          calls: record.secondlayer_calls || [],
        },
      },
    };
  }

  protected override async onTrackingComplete(
    record: any,
    _breakdown: CostBreakdown,
    totalCostUsd: number,
    status: 'completed' | 'failed'
  ): Promise<void> {
    // Increment Prometheus cost counter
    if (this.metricsCallback && totalCostUsd > 0) {
      this.metricsCallback(record.tool_name || 'unknown', totalCostUsd);
    }

    if (this.billingService && record.user_id && status === 'completed' && totalCostUsd > 0) {
      try {
        await this.billingService.chargeUser({
          userId: record.user_id,
          requestId: record.request_id,
          amountUsd: totalCostUsd,
          description: `${record.tool_name}: ${record.user_query?.substring(0, 100) || 'N/A'}`,
        });
        logger.debug('User automatically charged', {
          requestId: record.request_id,
          userId: record.user_id,
          amount: totalCostUsd.toFixed(6),
        });
      } catch (error: any) {
        logger.error('Failed to charge user automatically', {
          requestId: record.request_id,
          userId: record.user_id,
          error: error.message,
        });
      }
    }
  }
}
