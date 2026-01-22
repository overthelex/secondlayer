/**
 * ADR-002: QueryPlannerV2
 *
 * Demonstrates migration pattern by wrapping legacy QueryPlanner with shadow mode execution.
 * Phase 1 implementation: Runs new prompt architecture in parallel, always returns legacy result.
 */

import type { Pool } from 'pg';
import { QueryPlanner } from './query-planner.js';
import { ShadowModeExecutor } from './prompt/shadow-mode-executor.js';
import type { PromptIntent, PromptContext, PromptPolicy } from '../types/prompt.js';
import type { QueryIntent } from '../types/index.js';

export class QueryPlannerV2 {
  private legacy: QueryPlanner;
  private shadow: ShadowModeExecutor;

  constructor(pool: Pool) {
    this.legacy = new QueryPlanner();
    this.shadow = new ShadowModeExecutor(pool);
  }

  /**
   * Classify user intent with shadow mode execution
   */
  async classifyIntent(query: string, budget: 'quick' | 'standard' | 'deep' = 'standard'): Promise<QueryIntent> {
    // Define intent for new architecture
    const intent: PromptIntent = {
      name: 'classify_intent',
      reasoning_budget: budget,
      output_schema: {
        type: 'object',
        properties: {
          intent: { type: 'string' },
          confidence: { type: 'number' },
          domains: { type: 'array', items: { type: 'string' } },
          required_entities: { type: 'array', items: { type: 'string' } },
          sections: { type: 'array', items: { type: 'string' } },
          reasoning_budget: { type: 'string', enum: ['quick', 'standard', 'deep'] }
        }
      }
    };

    // Define context
    const context: PromptContext = {
      sources: [],
      user_query: query,
      metadata: {
        request_id: this.generateRequestId(),
        tool_name: 'classify_intent'
      }
    };

    // Define policy
    const policy: PromptPolicy = {
      max_tokens: 500,
      temperature: 0.3,
      allow_external_sources: false,
      require_citations: false,
      hallucination_guard_level: 'basic',
      retry_on_failure: false
    };

    // Execute in shadow mode (returns legacy result)
    return this.shadow.executeShadow<QueryIntent>(
      () => this.legacy.classifyIntent(query, budget),
      intent,
      context,
      policy
    );
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 9);
    return `req_${timestamp}_${random}`;
  }
}
