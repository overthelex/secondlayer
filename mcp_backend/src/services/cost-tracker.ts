import { BaseCostTracker, AdditionalCostResult } from '@secondlayer/shared';
import { CostEstimate, CostBreakdown } from '@secondlayer/shared';
import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';
import { maskSensitive, sanitizeId, sanitizeClassified } from '../utils/sanitize-log.js';
import { BillingService } from './billing-service.js';
import { getFixedToolPrice } from './tool-fixed-price.js';

export class CostTracker extends BaseCostTracker {
  private billingService?: BillingService;
  private metricsCallback?: (toolName: string, costUsd: number) => void;

  constructor(db: Database) {
    super(db, {
      enableOpenAI: true,
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

  override async createTrackingRecord(params: {
    requestId: string;
    toolName: string;
    clientKey?: string;
    userId?: string;
    userQuery: string;
    queryParams: any;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO cost_tracking (
        request_id, tool_name, client_key, user_id, user_query, query_params,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        params.requestId,
        params.toolName,
        params.clientKey || null,
        params.userId || null,
        sanitizeClassified((params.userQuery?.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') || '').substring(0, 500)),
        JSON.stringify(params.queryParams),
        'pending',
      ]
    );

    logger.debug('Cost tracking record created', {
      requestId: params.requestId,
    });
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

    switch (params.reasoningBudget) {
      case 'quick':
        estimatedTokens = 1000;
        break;
      case 'standard':
        estimatedTokens = 3000;
        break;
      case 'deep':
        estimatedTokens = 5000;
        break;
    }

    estimatedTokens += Math.floor(params.queryLength / 4);

    if (params.toolName === 'search_legal_precedents') {
      notes.push('Basic precedent search');
    } else if (params.toolName.includes('search')) {
      notes.push('Search operation');
    }

    let estimatedSecondLayerCalls = 0;
    if (params.toolName === 'search_legal_precedents' || params.toolName.includes('search')) {
      estimatedSecondLayerCalls = 5;
    }

    const monthlySecondLayerTotal = await this.getMonthlySecondLayerCallCount();
    const secondLayerCostPerCall = this.calculateSecondLayerCostPerCall(monthlySecondLayerTotal);
    const secondLayerEstimatedCost = estimatedSecondLayerCalls * secondLayerCostPerCall;

    const avgCostPer1kTokens = 0.002;
    const openaiEstimatedCost = (estimatedTokens / 1000) * avgCostPer1kTokens;

    const totalUsd = openaiEstimatedCost + secondLayerEstimatedCost;

    return {
      openai_estimated_tokens: estimatedTokens,
      openai_estimated_cost_usd: openaiEstimatedCost,
      secondlayer_estimated_calls: estimatedSecondLayerCalls,
      secondlayer_estimated_cost_usd: secondLayerEstimatedCost,
      total_estimated_cost_usd: totalUsd,
      estimation_notes: notes,
    };
  }

  protected override async calculateAdditionalCosts(record: any): Promise<AdditionalCostResult> {
    return {
      additionalCostUsd: 0,
      additionalBreakdownSections: {
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

    // Tools with a fixed price are billed by FixedPriceBilling in the MCP route, never here,
    // or a call with any usage cost would be charged twice.
    const fixedPrice = record.tool_name ? await getFixedToolPrice(this.db as any, record.tool_name) : null;
    if (this.billingService && record.user_id && status === 'completed' && totalCostUsd > 0 && !fixedPrice) {
      try {
        await this.billingService.chargeUser({
          userId: record.user_id,
          requestId: record.request_id,
          amountUsd: totalCostUsd,
          toolName: record.tool_name,
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
