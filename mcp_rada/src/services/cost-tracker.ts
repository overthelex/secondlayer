import { BaseCostTracker, AdditionalCostResult } from '@secondlayer/shared';
import { CostEstimate, RadaAPICallRecord } from '@secondlayer/shared';
import { Database } from '../database/database';
import { logger } from '../utils/logger';

export class CostTracker extends BaseCostTracker {
  constructor(db: Database) {
    super(db, {
      enableOpenAI: true,
      enableAnthropic: true,
      enableRadaAPI: true,
      enableSecondLayer: true,
    });
  }

  async recordRadaAPICall(params: {
    requestId: string;
    endpoint: string;
    cached: boolean;
    bytes?: number;
  }): Promise<void> {
    const callRecord: RadaAPICallRecord = {
      endpoint: params.endpoint,
      timestamp: new Date().toISOString(),
      cached: params.cached,
      bytes: params.bytes,
    };

    try {
      await this.db.query(
        `UPDATE cost_tracking
         SET rada_api_calls = rada_api_calls + 1,
             rada_api_cached = rada_api_cached + $1,
             rada_api_bytes = rada_api_bytes + $2,
             rada_calls = rada_calls || $3::jsonb
         WHERE request_id = $4`,
        [
          params.cached ? 1 : 0,
          params.bytes || 0,
          JSON.stringify([callRecord]),
          params.requestId,
        ]
      );

      const now = new Date();
      const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

      await this.db.query(
        `INSERT INTO monthly_api_usage (year_month, rada_total_calls, rada_total_cached, rada_total_bytes)
         VALUES ($1, 1, $2, $3)
         ON CONFLICT (year_month) DO UPDATE
         SET rada_total_calls = monthly_api_usage.rada_total_calls + 1,
             rada_total_cached = monthly_api_usage.rada_total_cached + $2,
             rada_total_bytes = monthly_api_usage.rada_total_bytes + $3,
             updated_at = NOW()`,
        [yearMonth, params.cached ? 1 : 0, params.bytes || 0]
      );

      logger.debug('RADA API call recorded', {
        requestId: params.requestId,
        endpoint: params.endpoint,
        cached: params.cached,
        bytes: params.bytes || 0,
      });
    } catch (error) {
      logger.error('Failed to record RADA API call:', error);
    }
  }

  async estimateCost(params: {
    toolName: string;
    queryLength: number;
    reasoningBudget: 'quick' | 'standard' | 'deep';
  }): Promise<CostEstimate> {
    const notes: string[] = [];
    let estimatedTokens = 0;
    let estimatedRadaCalls = 0;

    switch (params.reasoningBudget) {
      case 'quick':
        estimatedTokens = 1000;
        estimatedRadaCalls = 1;
        break;
      case 'standard':
        estimatedTokens = 3000;
        estimatedRadaCalls = 2;
        break;
      case 'deep':
        estimatedTokens = 5000;
        estimatedRadaCalls = 5;
        break;
    }

    estimatedTokens += Math.floor(params.queryLength / 4);

    if (params.toolName === 'analyze_voting_record' && params.reasoningBudget === 'deep') {
      estimatedRadaCalls += 3;
      estimatedTokens += 2000;
      notes.push('Deep voting pattern analysis includes AI insights');
    } else if (params.toolName === 'search_parliament_bills') {
      estimatedRadaCalls += 1;
      notes.push('Bill search with optional AI analysis');
    } else if (params.toolName === 'search_legislation_text') {
      estimatedRadaCalls += 1;
      notes.push('Law text search');
    }

    let estimatedSecondLayerCalls = 0;
    if (params.toolName === 'search_legislation_text') {
      estimatedSecondLayerCalls = 1;
      notes.push('Optional court case cross-referencing available');
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
      anthropic_estimated_tokens: 0,
      anthropic_estimated_cost_usd: 0,
      rada_estimated_calls: estimatedRadaCalls,
      secondlayer_estimated_calls: estimatedSecondLayerCalls,
      secondlayer_estimated_cost_usd: secondLayerEstimatedCost,
      total_estimated_cost_usd: totalUsd,
      estimation_notes: notes,
    };
  }

  protected override async calculateAdditionalCosts(record: any): Promise<AdditionalCostResult> {
    return {
      additionalCostUsd: 0, // RADA API is free
      additionalBreakdownSections: {
        rada_api: {
          total_calls: record.rada_api_calls || 0,
          cached_calls: record.rada_api_cached || 0,
          total_bytes: record.rada_api_bytes || 0,
          calls: record.rada_calls || [],
        },
      },
    };
  }
}
