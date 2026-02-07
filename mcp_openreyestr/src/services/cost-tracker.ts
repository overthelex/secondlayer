import { BaseCostTracker, AdditionalCostResult } from '@secondlayer/shared';
import { CostEstimate, DatabaseQueryRecord } from '@secondlayer/shared';
import { Database } from '../database/database';
import { logger } from '../utils/logger';

export class CostTracker extends BaseCostTracker {
  constructor(db: Database) {
    super(db, {
      enableOpenAI: true,
      enableAnthropic: true,
      enableDatabase: true,
      enableSecondLayer: true,
    });
  }

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

  async estimateCost(params: {
    toolName: string;
    queryLength: number;
    reasoningBudget: 'quick' | 'standard' | 'deep';
  }): Promise<CostEstimate> {
    const notes: string[] = [];
    let estimatedTokens = 0;
    let estimatedDbQueries = 1;

    switch (params.reasoningBudget) {
      case 'quick':
        estimatedTokens = 500;
        break;
      case 'standard':
        estimatedTokens = 1500;
        break;
      case 'deep':
        estimatedTokens = 3000;
        estimatedDbQueries += 2;
        break;
    }

    if (params.toolName === 'get_entity_details') {
      estimatedDbQueries += 8;
      notes.push('Retrieves entity with all related data (founders, beneficiaries, branches, etc.)');
    } else if (params.toolName === 'search_entities') {
      notes.push('Searches entities across all types (UO, FOP, FSU)');
      if (params.queryLength > 50) {
        estimatedDbQueries += 1;
      }
    } else if (params.toolName === 'search_beneficiaries') {
      estimatedDbQueries += 1;
      notes.push('Searches beneficiaries with entity lookups');
    }

    let estimatedSecondLayerCalls = 0;

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
      database_estimated_queries: estimatedDbQueries,
      secondlayer_estimated_calls: estimatedSecondLayerCalls,
      secondlayer_estimated_cost_usd: secondLayerEstimatedCost,
      total_estimated_cost_usd: totalUsd,
      estimation_notes: notes,
    };
  }

  protected override async calculateAdditionalCosts(record: any): Promise<AdditionalCostResult> {
    return {
      additionalCostUsd: 0, // Database queries are free
      additionalBreakdownSections: {
        database: {
          total_queries: record.database_queries_count || 0,
          total_rows: record.database_total_rows || 0,
          calls: record.database_calls || [],
        },
      },
    };
  }
}
