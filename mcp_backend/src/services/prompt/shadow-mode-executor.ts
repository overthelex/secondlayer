/**
 * ADR-002: ShadowModeExecutor
 *
 * Runs new prompt architecture in parallel with legacy for safe migration.
 * Always returns legacy result, but logs comparison metrics.
 */

import type { Pool } from 'pg';
import { PromptBuilder } from './prompt-builder.js';
import { PromptLifecycleManager } from './prompt-lifecycle-manager.js';
import { LLMClientManager } from '../../utils/llm-client-manager.js';
import { logger } from '../../utils/logger.js';
import type {
  PromptIntent,
  PromptContext,
  PromptPolicy,
  PromptInstance,
  PromptExecutionResult,
  SystemInstruction
} from '../../types/prompt.js';

export class ShadowModeExecutor {
  private builder: PromptBuilder;
  private lifecycle: PromptLifecycleManager;
  private llmManager: LLMClientManager;

  constructor(pool: Pool) {
    this.builder = new PromptBuilder();
    this.lifecycle = new PromptLifecycleManager(pool);
    this.llmManager = new LLMClientManager();
  }

  /**
   * Execute both legacy and new prompt systems in parallel
   * CRITICAL: Always returns legacy result in shadow mode
   */
  async executeShadow<T>(
    legacyFn: () => Promise<T>,
    intent: PromptIntent,
    context: PromptContext,
    policy: PromptPolicy
  ): Promise<T> {
    try {
      // Build new prompt (don't execute yet)
      const instance = this.builder.build(intent, context, policy);
      await this.lifecycle.recordInstance(instance);

      // Execute both in parallel (but don't wait for new one to succeed)
      const [legacyResult, newResult] = await Promise.allSettled([
        legacyFn(),
        this.executeNewPrompt(instance, policy).catch(err => {
          logger.warn('Shadow mode new prompt failed', { error: err.message });
          return null;
        })
      ]);

      // Log comparison (async, don't block)
      this.compareResults(instance.metadata.instance_id, legacyResult, newResult).catch(err => {
        logger.warn('Shadow mode comparison failed', { error: err.message });
      });

      // Always return legacy result
      if (legacyResult.status === 'fulfilled') {
        return legacyResult.value;
      } else {
        throw legacyResult.reason;
      }
    } catch (error) {
      logger.error('Shadow mode executor error', { error });
      // If shadow mode itself fails, still try to run legacy
      return legacyFn();
    }
  }

  /**
   * Execute prompt using new architecture
   */
  private async executeNewPrompt(
    instance: PromptInstance,
    policy: PromptPolicy
  ): Promise<any> {
    const startTime = Date.now();

    try {
      // Convert prompt instance to unified message format
      const messages = [
        ...instance.system.map((instr: SystemInstruction) => ({
          role: 'system' as const,
          content: instr.text
        })),
        {
          role: 'user' as const,
          content: instance.user
        }
      ];

      // Execute via unified LLM manager
      const response = await this.llmManager.chatCompletion(
        {
          messages,
          temperature: policy.temperature,
          max_tokens: policy.max_tokens
        },
        instance.intent.reasoning_budget
      );

      const executionTime = Date.now() - startTime;

      // Calculate cost (basic estimation)
      const costPerInputToken = 0.000001; // $1/1M tokens
      const costPerOutputToken = 0.000003; // $3/1M tokens
      const cost =
        (response.usage.prompt_tokens * costPerInputToken) +
        (response.usage.completion_tokens * costPerOutputToken);

      // Record execution
      const result: PromptExecutionResult = {
        instance_id: instance.metadata.instance_id,
        intent: instance.intent,
        output: response.content,
        model_used: response.model,
        tokens_used: {
          input: response.usage.prompt_tokens,
          output: response.usage.completion_tokens
        },
        cost_usd: cost,
        execution_time_ms: executionTime,
        validation_passed: true, // Will be set by validation layer later
        retry_count: 0,
        created_at: new Date()
      };

      await this.lifecycle.recordExecution(result);

      // Try to parse JSON if that's what we expect
      try {
        return JSON.parse(response.content);
      } catch {
        return response.content;
      }
    } catch (error) {
      logger.error('New prompt execution failed', {
        instance_id: instance.metadata.instance_id,
        error
      });
      throw error;
    }
  }

  /**
   * Compare results from legacy and new systems
   */
  private async compareResults(
    instanceId: string,
    legacy: PromiseSettledResult<any>,
    newPrompt: PromiseSettledResult<any>
  ): Promise<void> {
    const comparison = {
      instance_id: instanceId,
      legacy_status: legacy.status,
      new_status: newPrompt.status,
      outputs_match: false,
      legacy_value: legacy.status === 'fulfilled' ? this.sanitizeForLog(legacy.value) : null,
      new_value: newPrompt.status === 'fulfilled' ? this.sanitizeForLog(newPrompt.value) : null,
      legacy_error: legacy.status === 'rejected' ? legacy.reason?.message : null,
      new_error: newPrompt.status === 'rejected' ? newPrompt.reason?.message : null
    };

    // Compare outputs if both succeeded
    if (legacy.status === 'fulfilled' && newPrompt.status === 'fulfilled') {
      comparison.outputs_match = this.deepEqual(legacy.value, newPrompt.value);
    }

    logger.info('Shadow Mode Comparison', comparison);
  }

  /**
   * Deep equality check
   */
  private deepEqual(a: any, b: any): boolean {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }

  /**
   * Sanitize value for logging (truncate long strings)
   */
  private sanitizeForLog(value: any): any {
    if (typeof value === 'string' && value.length > 500) {
      return value.substring(0, 500) + '... [truncated]';
    }
    if (typeof value === 'object' && value !== null) {
      const str = JSON.stringify(value);
      if (str.length > 1000) {
        return str.substring(0, 1000) + '... [truncated]';
      }
    }
    return value;
  }
}
