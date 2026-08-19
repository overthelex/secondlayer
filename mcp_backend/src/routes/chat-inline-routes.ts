/**
 * Chat Inline Routes
 * Extracted from http-server.ts — chat plan review and SSE streaming chat endpoints
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest as DualAuthRequest } from '../middleware/dual-auth.js';
import { chatRateLimit } from '../middleware/rate-limit.js';
import { logger } from '../utils/logger.js';
import { ChatService } from '../services/chat-service.js';
import { BillingService } from '../services/billing-service.js';
import { CostTracker } from '../services/cost-tracker.js';
import { Database } from '../database/database.js';
import { v4 as uuidv4 } from 'uuid';
import { requestContext } from '../utils/openai-client.js';
import { runWithABUser } from '../infrastructure/adapters/llm-adapter.js';

/**
 * Wall-clock timeout for a chat request. ChatService auto-escalates
 * effectiveBudget up to maxBudget (default: deep) — e.g. plan >= 8 steps or a
 * queryType budget floor — so the backstop must cover the escalation ceiling,
 * not the requested budget. Keying it on the requested budget aborted
 * escalated runs mid-VERIFY at 240s (chat-f6e736b9, 2026-07-03).
 */
export const DEEP_TIMEOUT_MS = 600_000;
export const CAPPED_TIMEOUT_MS = 240_000;

/** Reads a positive-integer millisecond override, ignoring junk, zero and negatives:
 *  a typo in the deploy env must not turn the backstop into an instant abort. */
function envTimeoutMs(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (!raw) return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

export function resolveChatTimeoutMs(budget?: string, maxBudget?: string): number {
  const escalationCeiling = maxBudget || 'deep';
  // 600s (was 360s): a runaway backstop, not QoS — SSE heartbeats keep proxies
  // alive either way, and nginx `location /api` reads with a 300s idle timeout
  // that the 15s heartbeat already covers. 360s was set from chat-a79fffe7,
  // which spent 260s in EXECUTE alone (22 tool calls). Production then outgrew
  // it: on 2026-08-19 three of twelve runs (361s, 457s, 497s) were killed by the
  // backstop and persisted the "не завершена" stub, while every run that did
  // finish landed within 315s — i.e. 360s cut into the spread of a normal heavy
  // run instead of sitting outside it. Retune via CHAT_DEEP_TIMEOUT_MS rather
  // than by editing this line.
  return escalationCeiling === 'deep'
    ? envTimeoutMs('CHAT_DEEP_TIMEOUT_MS', DEEP_TIMEOUT_MS)
    : envTimeoutMs('CHAT_CAPPED_TIMEOUT_MS', CAPPED_TIMEOUT_MS);
}

/**
 * After the wall-clock timeout fires (or the client disconnects) the pipeline gets
 * this long to wind down: emit the verified answer, `complete` and `cost_summary`,
 * persist the turn, close the cost record. Sized for the slowest tail stage — an
 * unsupported-citation repair took 96s in chat-e26df847 (2026-07-20). Past it the
 * generator is dropped, which is a leak backstop, not a normal path.
 */
export const FINALIZE_GRACE_MS = 150_000;

export function createChatInlineRoutes(deps: {
  chatService: ChatService;
  billingService: BillingService;
  costTracker: CostTracker;
  db: Database;
}): Router {
  const router = Router();

  // POST /plan - Returns execution plan for user review before running
  router.post('/plan', chatRateLimit as any, (async (req: DualAuthRequest, res: Response) => {
    const userId = req.user?.id;
    const requestId = `plan-${uuidv4()}`;
    const startTime = Date.now();

    try {
      const { query, budget, internetEnabled } = req.body;

      if (!query || typeof query !== 'string') {
        return res.status(400).json({ error: 'query is required' });
      }

      await deps.costTracker.createTrackingRecord({
        requestId,
        toolName: 'chat_plan',
        clientKey: undefined,
        userId,
        userQuery: query.substring(0, 500),
        queryParams: { budget, internetEnabled },
      });

      const result = await requestContext.run(
        { requestId, task: 'chat_plan' },
        () => deps.chatService.generatePlanForReview(
          query,
          budget || 'standard',
          userId,
          requestId
        )
      );

      await deps.costTracker.completeTrackingRecord({
        requestId,
        executionTimeMs: Date.now() - startTime,
        status: 'completed',
      });

      if (!result) {
        return res.json({ plan: null, planSessionId: null, message: 'Simple query — no plan needed' });
      }

      res.json({
        plan: result.plan,
        planSessionId: result.planSessionId,
      });
    } catch (error: any) {
      logger.error('[ChatPlan] Endpoint error', { error: error.message, requestId });
      try {
        await deps.costTracker.completeTrackingRecord({
          requestId,
          executionTimeMs: Date.now() - startTime,
          status: 'failed',
          errorMessage: error.message,
        });
      } catch (_trackErr) {
        logger.error('[ChatPlan] Failed to record error in cost tracking', { requestId });
      }
      res.status(500).json({ error: 'Plan generation failed', message: error.message });
    }
  }) as any);

  // POST / - Main chat endpoint with SSE streaming
  router.post('/', chatRateLimit as any, (async (req: DualAuthRequest, res: Response) => {
    const userId = req.user?.id;
    const requestId = `chat-${uuidv4()}`;

    try {
      const { query, history, budget, maxBudget, conversationId, approvedPlan, planSessionId, allowDeepEscalation, internetEnabled, parallelSeedMin } = req.body;

      if (!query || typeof query !== 'string') {
        return res.status(400).json({ error: 'query is required' });
      }

      // Set SSE headers EARLY — before balance check — so client gets first byte faster
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      // Emit response_id as the very first SSE event for request traceability
      res.write(`event: response_id\n`);
      res.write(`data: ${JSON.stringify({ response_id: requestId })}\n\n`);

      // Pre-flight balance check — use BillingService (USD-based)
      // Now runs AFTER SSE is established; failures sent as SSE error events
      if (userId) {
        const billing = await deps.billingService.getOrCreateUserBilling(userId);
        if (billing.billing_enabled) {
          let estimatedCostUsd: number;

          // If an approved plan with step-level cost estimates is available, use that
          if (approvedPlan?.steps?.length > 0) {
            const stepsCost = approvedPlan.steps.reduce(
              (sum: number, s: any) => sum + (s.estimatedCost || 0),
              0
            );
            const overheadCost = approvedPlan.overheadCost || 0;
            estimatedCostUsd = stepsCost + overheadCost;
          } else {
            const estimatedCost = await deps.costTracker.estimateCost({
              toolName: 'ai_chat',
              queryLength: JSON.stringify(req.body).length,
              reasoningBudget: (budget || 'standard') as 'quick' | 'standard' | 'deep',
            });
            estimatedCostUsd = estimatedCost.total_estimated_cost_usd;
          }

          const balanceCheck = await deps.billingService.checkBalance(userId, estimatedCostUsd);
          if (!balanceCheck.hasBalance) {
            res.write(`event: error\n`);
            res.write(`data: ${JSON.stringify({
              error: 'Insufficient balance',
              message: `Недостатньо коштів на балансі. Поточний баланс: $${balanceCheck.currentBalance.toFixed(2)}. Поповніть баланс для продовження роботи.`,
              code: 'INSUFFICIENT_BALANCE',
              required_usd: estimatedCostUsd,
              current_balance_usd: balanceCheck.currentBalance,
            })}\n\n`);
            res.end();
            return;
          }
        }
      }

      // Abort controller for cancellation propagation
      const abortController = new AbortController();

      // Timing out is not the same as the client going away: on timeout the socket
      // is still open, so the run must be allowed to wind down (verify → citation
      // repair → `complete` → cost_summary) and the user must still get the answer,
      // the chat id and the cost. Only a real disconnect stops us writing.
      let clientGone = false;
      let hardStop = false;
      let hardStopTimer: NodeJS.Timeout | undefined;

      // Absolute wall-clock timeout to prevent runaway agentic loops
      const timeoutMs = resolveChatTimeoutMs(budget, maxBudget);
      const requestTimeout = setTimeout(() => {
        logger.warn('[ChatService] Request timed out — winding down', { requestId, timeoutMs, budget });
        // The signal stops the agentic loop from starting new work; the pipeline is
        // then given FINALIZE_GRACE_MS to finish what it already has in hand.
        abortController.abort();
        hardStopTimer = setTimeout(() => {
          logger.warn('[ChatService] Finalization grace expired — dropping stream', { requestId });
          hardStop = true;
        }, FINALIZE_GRACE_MS);
      }, timeoutMs);

      // SSE heartbeat to prevent proxy timeouts during long tool calls
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': heartbeat\n\n');
      }, 15000);

      req.on('close', () => {
        clientGone = true;
        clearInterval(heartbeat);
        abortController.abort();
        // Do NOT stop iterating here — the generator persists the turn and closes
        // the billing record on its way out, and only gets there if it is drained.
        if (!hardStopTimer) {
          hardStopTimer = setTimeout(() => { hardStop = true; }, FINALIZE_GRACE_MS);
        }
      });

      let chatCompleted = false;
      let chatTotalCostUsd = 0;
      // Aggregate search-leg usage across the turn so the UI can show how many
      // queries hit FTS (PostgreSQL full-text) vs Qdrant (vector/semantic).
      // Derived from each tool call's `mode` param on `thinking` events.
      const searchStats = { fts: 0, qdrant: 0, structured: 0 };
      const tallySearch = (tool?: string, mode?: string) => {
        if (tool === 'search_court_decisions' || tool === 'search_court_cases') {
          if (mode === 'fulltext') searchStats.fts += 1;
          else if (mode === 'semantic') searchStats.qdrant += 1;
          else if (mode === 'hybrid') { searchStats.fts += 1; searchStats.qdrant += 1; }
          else if (mode === 'structured') searchStats.structured += 1;
        } else if (tool === 'semantic_search') {
          searchStats.qdrant += 1;
        }
      };
      const chatRequest = {
        query,
        history,
        budget: (budget || 'standard') as 'quick' | 'standard' | 'deep',
        maxBudget: maxBudget as 'quick' | 'standard' | 'deep' | undefined,
        conversationId,
        userId,
        requestId,
        signal: abortController.signal,
        approvedPlan,
        planSessionId,
        allowDeepEscalation: !!allowDeepEscalation,
        internetEnabled: internetEnabled !== false,
        // A/B override for parallel-seed (CORE-36 grounding-eval). Number or undefined.
        parallelSeedMin: parallelSeedMin === undefined ? undefined : Number(parallelSeedMin),
      };
      try {
        await runWithABUser(userId || '', async () => {
          for await (const event of deps.chatService.chat(chatRequest)) {
            // Only a hard stop breaks the loop. Breaking calls generator.return(),
            // which skips the pipeline's persistence + cost-record closure — that is
            // how chat-e26df847 lost its answer and stayed `pending` forever.
            if (hardStop) break;

            if (event.type === 'thinking') {
              tallySearch(event.data?.tool, event.data?.params?.mode);
            }

            if (event.type === 'complete') {
              chatCompleted = true;
              chatTotalCostUsd = event.data?.total_cost_usd || 0;
              event.data.response_id = requestId;
              if (searchStats.fts || searchStats.qdrant || searchStats.structured) {
                event.data.search_stats = searchStats;
              }
              if (chatRequest.conversationId && chatRequest.conversationId !== conversationId) {
                event.data.conversationId = chatRequest.conversationId;
              }
              if (abortController.signal.aborted) {
                // Answer is real but the run was cut short — let the UI say so.
                event.data.truncated = true;
              }
            }

            // Client hung up: keep draining so the generator finalizes, just stop writing.
            if (clientGone || res.writableEnded) continue;

            res.write(`event: ${event.type}\n`);
            res.write(`data: ${JSON.stringify(event.data)}\n\n`);
          }
        });

        if (abortController.signal.aborted && !chatCompleted && !clientGone && !res.writableEnded) {
          logger.warn('[ChatService] Sending timeout error to client', { requestId });
          res.write(`event: error\n`);
          res.write(`data: ${JSON.stringify({ message: 'Час очікування вичерпано. Спробуйте уточнити запит.' })}\n\n`);
        }
      } finally {
        clearTimeout(requestTimeout);
        if (hardStopTimer) clearTimeout(hardStopTimer);
        clearInterval(heartbeat);
      }

      // Emit cost_summary SSE event — billing was already handled by CostTracker.onTrackingComplete()
      if (chatCompleted && userId && chatTotalCostUsd > 0 && !clientGone && !res.writableEnded) {
        try {
          const [summary, trackingRow] = await Promise.all([
            deps.billingService.getBillingSummary(userId),
            // chargeUser() already updated total_cost_usd to the marked-up amount
            deps.db.query(
              'SELECT total_cost_usd, markup_percentage FROM cost_tracking WHERE request_id = $1',
              [requestId]
            ),
          ]);
          const chargedUsd = trackingRow.rows[0]?.total_cost_usd
            ? parseFloat(trackingRow.rows[0].total_cost_usd)
            : chatTotalCostUsd;
          const hasSearchStats = searchStats.fts || searchStats.qdrant || searchStats.structured;
          const costSummaryFull = {
            total_cost_usd: chatTotalCostUsd,
            charged_usd: chargedUsd,
            balance_usd: summary?.balance_usd ?? 0,
            response_id: requestId,
            ...(hasSearchStats ? { search_stats: searchStats } : {}),
          };
          res.write(`event: cost_summary\n`);
          res.write(`data: ${JSON.stringify({
            ...costSummaryFull,
            markup_percentage: trackingRow.rows[0]?.markup_percentage ?? 0,
          })}\n\n`);

          // Persist charged_usd + search_stats back to conversation_messages so reload
          // shows correct cost and the FTS/Qdrant breakdown. Merge into the existing
          // cost_summary JSONB so already-saved fields (e.g. tools_used) are preserved.
          // Use the effective id — ChatService fills chatRequest.conversationId in
          // when it auto-creates the conversation, and those turns need the cost too.
          const effectiveConversationId = chatRequest.conversationId || conversationId;
          if (effectiveConversationId) {
            deps.db.query(
              `UPDATE conversation_messages
               SET cost_summary = COALESCE(cost_summary, '{}'::jsonb) || $1::jsonb
               WHERE id = (
                 SELECT id FROM conversation_messages
                 WHERE conversation_id = $2 AND role = 'assistant'
                 ORDER BY created_at DESC LIMIT 1
               )`,
              [JSON.stringify(costSummaryFull), effectiveConversationId]
            ).catch(e => logger.warn('[ChatService] Failed to persist charged_usd', { error: e.message }));
          }
        } catch (e: any) {
          logger.warn('[ChatService] Failed to emit cost_summary', { error: e.message, requestId });
        }
      }

      if (!res.writableEnded) {
        res.end();
      }
    } catch (error: any) {
      logger.error('[ChatService] Endpoint error', { error: error.message, requestId });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Chat failed', message: error.message });
      } else if (!res.writableEnded) {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ message: error.message })}\n\n`);
        res.end();
      }
    }
  }) as any);

  return router;
}
