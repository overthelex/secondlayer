/**
 * WorkflowExecutorService — Executes a workflow's plan steps via ToolRegistry,
 * then runs a Bedrock-powered institutional-level analysis of the collected results.
 */

import { logger } from '../utils/logger.js';
import { scopeVaultArgs } from '../api/tool-access-policy.js';
import { ToolRegistry } from '../api/tool-registry.js';
import { WorkflowService, WorkflowRow } from './workflow-service.js';
import { CostTracker } from './cost-tracker.js';
import type { ILLMPort } from '../domain/ports/index.js';

export interface WorkflowSSEEvent {
  type: 'step_start' | 'step_complete' | 'step_error' | 'workflow_complete' | 'heartbeat' | 'analysis_start' | 'analysis_delta' | 'analysis_complete';
  data: any;
}

const ANALYSIS_SYSTEM_PROMPT = `Ти — старший юридичний аналітик платформи SecondLayer. Твоє завдання — провести глибокий інституційний аналіз зібраних даних та підготувати структурований звіт.

## Правила
1. Пиши ВИКЛЮЧНО українською мовою
2. Аналізуй ВСІ надані дані — не пропускай жодного результату кроку
3. Використовуй конкретні цифри, дати, номери справ з результатів
4. Структуруй звіт за розділами з заголовками (## markdown)
5. Роби практичні висновки та рекомендації для юриста
6. Якщо дані містять помилки або відсутні — зазнач це явно
7. Порівнюй та зіставляй результати між різними кроками

## Структура звіту
1. **Резюме** — 2-3 речення, головний висновок
2. **Статистичний огляд** — кількість справ, розподіл, тренди
3. **Ключові правові позиції** — основні висновки судів, прецеденти
4. **Нормативна база** — релевантне законодавство
5. **Практичні рекомендації** — конкретні поради для адвоката/юриста
6. **Ризики та застереження** — на що звернути увагу`;

export class WorkflowExecutorService {
  private runningWorkflows = new Map<string, AbortController>();

  constructor(
    private toolRegistry: ToolRegistry,
    private workflowService: WorkflowService,
    private costTracker: CostTracker,
    private llm: ILLMPort
  ) {}

  /**
   * Execute a single workflow. Yields SSE events for streaming.
   * After all tool steps, runs Bedrock analysis of collected results.
   */
  async *execute(workflow: WorkflowRow, userId: string, signal?: AbortSignal): AsyncGenerator<WorkflowSSEEvent> {
    const controller = new AbortController();
    this.runningWorkflows.set(workflow.id, controller);

    // Link external signal
    if (signal) {
      signal.addEventListener('abort', () => controller.abort());
    }

    const plan = workflow.plan as { goal: string; steps: Array<{ id: number; tool: string; params: Record<string, any>; purpose: string }> };
    if (!plan.steps || plan.steps.length === 0) {
      yield { type: 'workflow_complete', data: { workflowId: workflow.id, status: 'completed', results: {} } };
      return;
    }

    await this.workflowService.updateWorkflowStatus(workflow.id, 'running');

    const stepResults: Record<string | number, any> = {};
    let totalCostUsd = 0;

    // Heartbeat interval (15 seconds) for proxy keepalive
    const heartbeatInterval = setInterval(() => {
      // Heartbeat is yielded via a flag checked in the main loop
    }, 15000);
    let lastHeartbeat = Date.now();

    try {
      // --- Phase 1: Execute tool steps ---
      for (let i = 0; i < plan.steps.length; i++) {
        if (controller.signal.aborted) {
          await this.workflowService.updateWorkflowStatus(workflow.id, 'cancelled');
          break;
        }

        const step = plan.steps[i];

        // Emit step_start (totalSteps includes analysis step)
        yield {
          type: 'step_start',
          data: {
            workflowId: workflow.id,
            stepId: step.id,
            stepIndex: i,
            totalSteps: plan.steps.length + 1, // +1 for analysis
            tool: step.tool,
            purpose: step.purpose,
          },
        };

        // Update progress
        await this.workflowService.updateWorkflowProgress(workflow.id, {
          currentStep: i + 1,
          totalSteps: plan.steps.length + 1,
          currentTool: step.tool,
        });

        try {
          // Inject userId for vault tools
          const toolArgs = scopeVaultArgs(step.tool, step.params || {}, userId);

          const result = await this.toolRegistry.executeTool(step.tool, toolArgs);
          stepResults[step.id] = result;

          yield {
            type: 'step_complete',
            data: {
              workflowId: workflow.id,
              stepId: step.id,
              stepIndex: i,
              tool: step.tool,
              result,
            },
          };
        } catch (err: any) {
          logger.error('[WorkflowExecutor] Step failed', { workflowId: workflow.id, step: step.id, tool: step.tool, error: err.message });
          stepResults[step.id] = { error: err.message };

          yield {
            type: 'step_error',
            data: {
              workflowId: workflow.id,
              stepId: step.id,
              tool: step.tool,
              error: err.message,
            },
          };
          // Continue with remaining steps even if one fails
        }

        // Heartbeat if more than 15s since last event
        if (Date.now() - lastHeartbeat > 15000) {
          yield { type: 'heartbeat', data: {} };
          lastHeartbeat = Date.now();
        }
      }

      // --- Phase 2: Bedrock institutional analysis ---
      if (!controller.signal.aborted) {
        yield {
          type: 'analysis_start',
          data: { workflowId: workflow.id },
        };

        await this.workflowService.updateWorkflowProgress(workflow.id, {
          currentStep: plan.steps.length + 1,
          totalSteps: plan.steps.length + 1,
          currentTool: 'bedrock_analysis',
        });

        try {
          let analysis = '';

          // Build context from all step results
          const stepsContext = plan.steps.map((step) => {
            const result = stepResults[step.id];
            // Truncate large results to avoid exceeding context
            const resultStr = JSON.stringify(result, null, 2);
            const truncated = resultStr.length > 15000
              ? resultStr.slice(0, 15000) + '\n... [скорочено]'
              : resultStr;
            return `### Крок ${step.id}: ${step.purpose}\nІнструмент: ${step.tool}\nРезультат:\n\`\`\`json\n${truncated}\n\`\`\``;
          }).join('\n\n');

          const userMessage = `## Завдання аналізу\nЦіль workflow: ${plan.goal}\n\n## Зібрані дані\n${stepsContext}\n\nПроведи глибокий інституційний аналіз цих даних та підготуй структурований звіт.`;

          // Stream analysis via Bedrock (preferred) with fallback
          const stream = this.llm.chatCompletionStream(
            {
              messages: [
                { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
                { role: 'user', content: userMessage },
              ],
              max_tokens: 8000,
              temperature: 0.2,
            },
            'deep',
            'bedrock'
          );

          for await (const chunk of stream) {
            if (controller.signal.aborted) break;

            if (chunk.type === 'text_delta' && chunk.text) {
              analysis += chunk.text;
              yield {
                type: 'analysis_delta',
                data: { workflowId: workflow.id, text: chunk.text },
              };
            }

            if (chunk.type === 'usage' && chunk.usage) {
              const costUsd = this.estimateAnalysisCost(chunk.usage.prompt_tokens, chunk.usage.completion_tokens, chunk.model);
              totalCostUsd += costUsd;
            }

            // Heartbeat during analysis
            if (Date.now() - lastHeartbeat > 15000) {
              yield { type: 'heartbeat', data: {} };
              lastHeartbeat = Date.now();
            }
          }

          yield {
            type: 'analysis_complete',
            data: { workflowId: workflow.id, analysis },
          };

          // Store analysis alongside step results
          stepResults['analysis'] = analysis;

          logger.info('[WorkflowExecutor] Analysis complete', {
            workflowId: workflow.id,
            analysisLength: analysis.length,
            costUsd: totalCostUsd,
          });
        } catch (err: any) {
          logger.error('[WorkflowExecutor] Analysis failed', { workflowId: workflow.id, error: err.message });
          stepResults['analysis'] = { error: `Аналіз не вдався: ${err.message}` };
          yield {
            type: 'step_error',
            data: {
              workflowId: workflow.id,
              tool: 'bedrock_analysis',
              error: err.message,
            },
          };
        }

        // Save results
        await this.workflowService.updateWorkflowResults(workflow.id, stepResults, totalCostUsd);
        yield {
          type: 'workflow_complete',
          data: {
            workflowId: workflow.id,
            status: 'completed',
            stepCount: plan.steps.length,
            costUsd: totalCostUsd,
          },
        };
      }
    } catch (err: any) {
      logger.error('[WorkflowExecutor] Workflow failed', { workflowId: workflow.id, error: err.message });
      await this.workflowService.updateWorkflowStatus(workflow.id, 'failed', err.message);
      yield {
        type: 'step_error',
        data: {
          workflowId: workflow.id,
          error: err.message,
        },
      };
    } finally {
      clearInterval(heartbeatInterval);
      this.runningWorkflows.delete(workflow.id);
    }
  }

  private estimateAnalysisCost(inputTokens: number, outputTokens: number, model?: string): number {
    // Bedrock Claude Sonnet 4.6 pricing (per 1M tokens)
    const m = model || '';
    if (m.includes('opus')) {
      return (inputTokens * 15 + outputTokens * 75) / 1_000_000;
    }
    if (m.includes('haiku')) {
      return (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;
    }
    // Default: Sonnet pricing
    return (inputTokens * 3 + outputTokens * 15) / 1_000_000;
  }

  cancel(workflowId: string): boolean {
    const controller = this.runningWorkflows.get(workflowId);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
  }

  isRunning(workflowId: string): boolean {
    return this.runningWorkflows.has(workflowId);
  }
}
