import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dualAuth, AuthenticatedRequest as DualAuthRequest } from '../middleware/dual-auth.js';
import { createBalanceCheckMiddleware } from '../middleware/balance-check.js';
import { logger } from '../utils/logger.js';
import { gatedRegistryOf, checkJudgmentAccess, logJudgmentAccess } from '../services/uk-judgment-access.js';
import { requestContext } from '../utils/openai-client.js';
import { ToolRegistry } from '../api/tool-registry.js';
import { ServiceProxy } from '../services/service-proxy.js';
import { BillingService } from '../services/billing-service.js';
import { CostTracker } from '../services/cost-tracker.js';
import { CreditService } from '../services/credit-service.js';
import { BatchDocumentTools } from '../api/batch-document-tools.js';
import { ServiceType } from '../types/gateway.js';

function sendSSEEvent(res: Response, event: {
  type: string;
  data: any;
  id?: string;
}): void {
  try {
    if (event.id) {
      res.write(`id: ${event.id}\n`);
    }
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  } catch (error) {
    logger.error('Error sending SSE event:', error);
  }
}

async function handleStreamingProxyCall(
  _req: DualAuthRequest,
  res: Response,
  service: ServiceType,
  serviceName: string,
  args: any,
  requestId: string,
  deps: {
    serviceProxy: ServiceProxy;
    costTracker: CostTracker;
  }
): Promise<void> {
  // Validate service is not backend
  if (service === 'backend') {
    throw new Error('Cannot proxy backend service');
  }
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    logger.info('[Gateway SSE] Proxying stream from remote service', {
      requestId,
      service,
      tool: serviceName,
    });

    // Get remote service stream
    const stream = await deps.serviceProxy.callRemoteService({
      service,
      serviceName,
      args,
      requestId,
      acceptHeader: 'text/event-stream',
    });

    // Parse SSE events to extract cost_tracking from 'complete' event
    let extractedCostUsd = 0;
    let extractedCostDetails: any = null;
    let sseBuffer = '';

    // Forward SSE events from remote service to client
    stream.on('data', (chunk: Buffer) => {
      const chunkStr = chunk.toString();
      res.write(chunk);

      // Buffer SSE data to parse complete events for cost extraction
      sseBuffer += chunkStr;
      const events = sseBuffer.split('\n\n');
      sseBuffer = events.pop() || ''; // Keep incomplete event in buffer

      for (const event of events) {
        if (event.includes('event: complete') || event.includes('event:complete')) {
          const dataMatch = event.match(/data:\s*(.+)/);
          if (dataMatch) {
            try {
              const parsed = JSON.parse(dataMatch[1]);
              const costData = parsed?.cost_tracking?.actual_cost;
              if (costData) {
                extractedCostUsd = costData.totals?.cost_usd || costData.total_cost_usd || 0;
                extractedCostDetails = costData;
              }
            } catch { /* ignore parse errors */ }
          }
        }
      }
    });

    stream.on('end', async () => {
      logger.info('[Gateway SSE] Stream completed', { requestId, service });

      // Record extracted cost from remote SSE stream
      if (extractedCostUsd > 0) {
        try {
          await deps.costTracker.recordRemoteServiceCall({
            requestId,
            service: service as 'rada' | 'openreyestr',
            toolName: serviceName,
            costUsd: extractedCostUsd,
            details: extractedCostDetails,
          });
        } catch (costErr: any) {
          logger.error('[Gateway SSE] Failed to record stream cost', {
            requestId, error: costErr.message,
          });
        }
      }

      res.end();
    });

    stream.on('error', (error: Error) => {
      logger.error('[Gateway SSE] Stream error', {
        requestId,
        service,
        error: error.message,
      });
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ message: error.message })}\n\n`);
      res.end();
    });
  } catch (error: any) {
    logger.error('[Gateway SSE] Proxy failed', {
      requestId,
      service,
      error: error.message,
    });

    // Send error event
    res.write(`event: error\n`);
    res.write(`data: ${JSON.stringify({ message: error.message })}\n\n`);
    res.end();
  }
}

async function handleStreamingToolCall(
  _req: DualAuthRequest,
  res: Response,
  toolName: string,
  args: any,
  deps: {
    toolRegistry: ToolRegistry;
    batchDocumentTools: BatchDocumentTools;
  }
): Promise<void> {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Send initial connection event
  sendSSEEvent(res, {
    type: 'connected',
    data: { tool: toolName, timestamp: new Date().toISOString() },
    id: 'connection',
  });

  try {
    // Streaming support for different tools
    if (deps.toolRegistry.supportsStreaming(toolName)) {
      await deps.toolRegistry.executeToolStream(toolName, args, (event: any) => {
        sendSSEEvent(res, event);
      });
    } else if (toolName === 'batch_process_documents') {
      // Batch document processing with real-time progress
      await deps.batchDocumentTools.processBatch(args, (event) => {
        sendSSEEvent(res, event);
      });
    } else {
      // For other tools, stream the regular result
      const result = await deps.toolRegistry.executeTool(toolName, args);
      if (result === null || result === undefined) {
        sendSSEEvent(res, {
          type: 'error',
          data: { message: `No handler registered for tool: ${toolName}` },
          id: 'error',
        });
      } else {
        sendSSEEvent(res, {
          type: 'progress',
          data: { message: 'Processing...', progress: 0.5 },
          id: 'processing',
        });
        sendSSEEvent(res, {
          type: 'complete',
          data: result,
          id: 'final',
        });
      }
    }
  } catch (error: any) {
    sendSSEEvent(res, {
      type: 'error',
      data: {
        message: error.message,
        error: error.toString(),
      },
      id: 'error',
    });
  } finally {
    // Send end event and close connection
    sendSSEEvent(res, {
      type: 'end',
      data: { message: 'Stream completed' },
      id: 'end',
    });
    res.end();
  }
}

export function createToolExecutionRoutes(deps: {
  toolRegistry: ToolRegistry;
  // Needed only by the Find Case Law licence gate; see services/uk-judgment-access.
  db: any;
  serviceProxy: ServiceProxy;
  billingService: BillingService;
  costTracker: CostTracker;
  creditService: CreditService;
  batchDocumentTools: BatchDocumentTools;
}): Router {
  const router = Router();
  const balanceCheckMiddleware = createBalanceCheckMiddleware(deps.billingService, deps.costTracker);

  // Inject apiVersion into all JSON responses from this router
  router.use((_req: Request, res: Response, next) => {
    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        body.apiVersion = 'v1';
      }
      return originalJson(body);
    };
    next();
  });

  // GET / — List available tools
  router.get('/', dualAuth as any, (async (_req: DualAuthRequest, res: Response) => {
    try {
      const gatewayEnabled = process.env.ENABLE_UNIFIED_GATEWAY === 'true';

      if (gatewayEnabled) {
        const allTools = await deps.toolRegistry.getAllTools(
          deps.toolRegistry.getLocalToolDefinitions(),
          process.env.RADA_MCP_URL,
          process.env.RADA_API_KEY,
          process.env.OPENREYESTR_MCP_URL,
          process.env.OPENREYESTR_API_KEY
        );

        const counts = deps.toolRegistry.getToolCounts();

        res.json({
          tools: allTools,
          count: allTools.length,
          gateway: {
            enabled: true,
            services: counts,
          },
        });
      } else {
        const tools = deps.toolRegistry.getLocalToolDefinitions();

        res.json({
          tools,
          count: tools.length,
          gateway: {
            enabled: false,
          },
        });
      }
    } catch (error: any) {
      logger.error('Error listing tools:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: error.message,
      });
    }
  }) as any);

  // POST /batch — Batch tool calls (must be before /:toolName)
  router.post('/batch', dualAuth as any, balanceCheckMiddleware as any, (async (req: DualAuthRequest, res: Response): Promise<void> => {
    try {
      const { calls } = req.body;

      if (!Array.isArray(calls)) {
        res.status(400).json({
          error: 'Invalid request',
          message: 'Expected array of tool calls in "calls" field',
        });
        return;
      }

      const results = await Promise.all(
        calls.map(async (call: { name: string; arguments?: any }) => {
          // Same licence gate as the single-tool route: a batch must not be a way
          // around it.
          const batchGated = gatedRegistryOf(call.name, call.arguments || {});
          if (batchGated) {
            const decision = await checkJudgmentAccess(deps.db, req.user?.id);
            if (!decision.allowed) {
              return { name: call.name, error: 'Forbidden', message: decision.message };
            }
            await logJudgmentAccess(deps.db, req.user?.id, batchGated,
                                    (call.arguments || {}).filters);
          }
          const callRequestId = `batch-${uuidv4()}`;
          const callStartTime = Date.now();

          try {
            await deps.costTracker.createTrackingRecord({
              requestId: callRequestId,
              toolName: call.name,
              clientKey: req.clientKey,
              userId: req.user?.id,
              userQuery: JSON.stringify(call.arguments || {}),
              queryParams: call.arguments || {},
            });

            const result = await requestContext.run(
              { requestId: callRequestId, task: call.name },
              () => deps.toolRegistry.executeTool(call.name, call.arguments || {})
            );

            const breakdown = await deps.costTracker.completeTrackingRecord({
              requestId: callRequestId,
              executionTimeMs: Date.now() - callStartTime,
              status: result !== null && result !== undefined ? 'completed' : 'failed',
              errorMessage: result === null || result === undefined ? `No handler registered for tool: ${call.name}` : undefined,
            });

            if (result === null || result === undefined) {
              return {
                tool: call.name,
                success: false,
                error: `No handler registered for tool: ${call.name}`,
                cost_tracking: { request_id: callRequestId, actual_cost: breakdown },
              };
            }
            return {
              tool: call.name,
              success: true,
              result,
              cost_tracking: { request_id: callRequestId, actual_cost: breakdown },
            };
          } catch (error: any) {
            try {
              await deps.costTracker.completeTrackingRecord({
                requestId: callRequestId,
                executionTimeMs: Date.now() - callStartTime,
                status: 'failed',
                errorMessage: error.message,
              });
            } catch (_trackErr) {
              logger.error('Failed to record batch call error in cost tracking', { callRequestId });
            }
            return {
              tool: call.name,
              success: false,
              error: error.message,
              cost_tracking: { request_id: callRequestId },
            };
          }
        })
      );

      res.json({
        success: true,
        results,
      });
    } catch (error: any) {
      logger.error('Batch tool call error:', error);
      res.status(500).json({
        error: 'Batch execution failed',
        message: error.message,
      });
    }
  }) as any);

  // POST /:toolName/stream — Dedicated SSE streaming endpoint
  router.post('/:toolName/stream', dualAuth as any, balanceCheckMiddleware as any, (async (req: DualAuthRequest, res: Response) => {
    const streamRequestId = `stream-${uuidv4()}`;
    const streamStartTime = Date.now();

    try {
      const toolName = Array.isArray(req.params.toolName) ? req.params.toolName[0] : req.params.toolName;
      if (!toolName) {
        return res.status(400).json({ error: 'Tool name is required' });
      }
      const args = req.body.arguments || req.body;

      logger.info('Streaming tool call request', {
        requestId: streamRequestId,
        tool: toolName,
        clientKey: req.clientKey?.substring(0, 8) + '...',
      });

      await deps.costTracker.createTrackingRecord({
        requestId: streamRequestId,
        toolName,
        clientKey: req.clientKey,
        userId: req.user?.id,
        userQuery: args.query || JSON.stringify(args),
        queryParams: args,
      });

      await requestContext.run(
        { requestId: streamRequestId, task: toolName },
        () => handleStreamingToolCall(req, res, toolName, args, {
          toolRegistry: deps.toolRegistry,
          batchDocumentTools: deps.batchDocumentTools,
        })
      );

      await deps.costTracker.completeTrackingRecord({
        requestId: streamRequestId,
        executionTimeMs: Date.now() - streamStartTime,
        status: 'completed',
      });
    } catch (error: any) {
      logger.error('Streaming tool call error:', error);
      try {
        await deps.costTracker.completeTrackingRecord({
          requestId: streamRequestId,
          executionTimeMs: Date.now() - streamStartTime,
          status: 'failed',
          errorMessage: error.message,
        });
      } catch (_trackErr) {
        logger.error('Failed to record stream error in cost tracking', { streamRequestId });
      }
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Tool execution failed',
          message: error.message,
          tool: req.params.toolName,
        });
      }
    }
  }) as any);

  // POST /:toolName — Execute MCP tool (with SSE support and cost tracking)
  router.post('/:toolName', dualAuth as any, balanceCheckMiddleware as any, (async (req: DualAuthRequest, res: Response) => {
    const requestId = uuidv4();
    const startTime = Date.now();

    try {
      const toolName = Array.isArray(req.params.toolName) ? req.params.toolName[0] : req.params.toolName;
      if (!toolName) {
        return res.status(400).json({ error: 'Tool name is required' });
      }
      const args = req.body.arguments || req.body;
      const acceptHeader = req.headers.accept || '';

      // Find Case Law licence gate. Question 13 of TNA ref CAS-349914-B9P5B8 says
      // the judgments are restricted to legal professionals and researchers, so
      // authentication alone is not enough here — the account has to be one we
      // have granted. Costs a Set lookup on every other tool call.
      const gatedRegistry = gatedRegistryOf(toolName, args);
      if (gatedRegistry) {
        const decision = await checkJudgmentAccess(deps.db, req.user?.id);
        if (!decision.allowed) {
          logger.info('UK judgment access denied', {
            requestId, userId: req.user?.id, registry: gatedRegistry,
          });
          return res.status(403).json({
            success: false,
            error: 'Forbidden',
            message: decision.message,
          });
        }
        await logJudgmentAccess(deps.db, req.user?.id, gatedRegistry, args?.filters);
      }

      logger.info('Tool call request', {
        requestId,
        tool: toolName,
        clientKey: req.clientKey?.substring(0, 8) + '...',
        streaming: acceptHeader.includes('text/event-stream'),
      });

      // 1. Check credits BEFORE execution (for API key users)
      if (req.authType === 'apikey' && req.user?.id) {
        try {
          const creditsRequired = await deps.creditService.calculateCreditsForTool(toolName, req.user.id);

          if (creditsRequired > 0) {
            const balance = await deps.creditService.checkBalance(req.user.id, creditsRequired);

            if (!balance.hasCredits) {
              logger.warn('[HTTP API] Insufficient credits, blocking request', {
                userId: req.user.id,
                tool: toolName,
                creditsRequired,
                currentBalance: balance.currentBalance,
              });

              return res.status(402).json({
                error: 'Insufficient credits',
                code: 'INSUFFICIENT_CREDITS',
                currentBalance: balance.currentBalance,
                creditsRequired,
                message: 'Your credit balance is too low to perform this operation. Please purchase more credits.',
              });
            }

            logger.debug('[HTTP API] Credit check passed', {
              userId: req.user.id,
              tool: toolName,
              creditsRequired,
              currentBalance: balance.currentBalance,
            });
          }
        } catch (creditError: any) {
          logger.error('[HTTP API] Error checking credits', {
            userId: req.user.id,
            tool: toolName,
            error: creditError.message,
          });
          return res.status(503).json({
            error: 'Service temporarily unavailable',
            message: 'Credit check system is temporarily unavailable. Please try again later.',
            code: 'BILLING_UNAVAILABLE',
          });
        }
      }

      // 2. Create tracking record (pending)
      await deps.costTracker.createTrackingRecord({
        requestId,
        toolName,
        clientKey: req.clientKey,
        userId: req.user?.id,
        userQuery: args.query || JSON.stringify(args),
        queryParams: args,
      });

      // 3. Estimate cost BEFORE execution
      const estimate = await deps.costTracker.estimateCost({
        toolName,
        queryLength: (args.query || '').length,
        reasoningBudget: args.reasoning_budget || 'standard',
      });

      logger.info('Cost estimate before execution', {
        requestId,
        toolName,
        estimate,
      });

      // 4. Route to appropriate service (GATEWAY LOGIC)
      const gatewayEnabled = process.env.ENABLE_UNIFIED_GATEWAY === 'true';
      const route = gatewayEnabled ? deps.toolRegistry.getRoute(toolName) : null;

      let result: any;

      if (gatewayEnabled && route && !route.local) {
        // PROXIED EXECUTION - call remote service (RADA or OpenReyestr)
        logger.info('[Gateway] Proxying to remote service', {
          requestId,
          tool: toolName,
          service: route.service,
          serviceName: route.serviceName,
        });

        // Check if client wants SSE streaming
        if (acceptHeader.includes('text/event-stream')) {
          return await handleStreamingProxyCall(
            req,
            res,
            route.service,
            route.serviceName,
            args,
            requestId,
            { serviceProxy: deps.serviceProxy, costTracker: deps.costTracker }
          );
        }

        // Regular JSON request to remote service
        const remoteResult = await deps.serviceProxy.callRemoteService({
          service: route.service,
          serviceName: route.serviceName,
          args,
          requestId,
        });

        result = remoteResult.result || remoteResult;

      } else {
        // LOCAL EXECUTION - backend tools
        logger.debug('[Gateway] Executing locally', {
          requestId,
          tool: toolName,
          gatewayEnabled,
          routeFound: !!route,
        });

        // Check if client wants SSE streaming
        if (acceptHeader.includes('text/event-stream')) {
          return handleStreamingToolCall(req, res, toolName, args, {
            toolRegistry: deps.toolRegistry,
            batchDocumentTools: deps.batchDocumentTools,
          });
        }

        // Execute in request context
        result = await requestContext.run(
          { requestId, task: toolName },
          async () => {
            const VAULT_TOOLS = new Set(['store_document', 'get_document', 'list_documents', 'semantic_search', 'list_folders', 'delete_document', 'update_document']);
            const vaultUserId = req.user?.id || process.env.DEFAULT_VAULT_USER_ID;
            const httpToolArgs = VAULT_TOOLS.has(toolName) ? { ...args, userId: vaultUserId } : args;
            return await deps.toolRegistry.executeTool(toolName, httpToolArgs);
          }
        );
      }

      // 4.5. Guard: if executeTool returned null, the tool doesn't exist
      if (result === null || result === undefined) {
        res.status(404).json({
          success: false,
          error: 'Tool not found',
          message: `No handler registered for tool: ${toolName}`,
        });
        return;
      }

      // 5. Complete tracking and get breakdown
      const executionTime = Date.now() - startTime;
      const breakdown = await deps.costTracker.completeTrackingRecord({
        requestId,
        executionTimeMs: executionTime,
        status: 'completed',
      });

      logger.info('Request completed with cost tracking', {
        requestId,
        toolName,
        totalCostUsd: breakdown.totals.cost_usd.toFixed(6),
      });

      // 6. Deduct credits after successful execution (for API key users)
      if (req.authType === 'apikey' && req.user?.id) {
        try {
          const creditsRequired = await deps.creditService.calculateCreditsForTool(toolName, req.user.id);

          if (creditsRequired > 0) {
            const deduction = await deps.creditService.deductCredits(
              req.user.id,
              creditsRequired,
              toolName,
              requestId,
              `Tool execution: ${toolName}`
            );

            if (deduction.success) {
              logger.info('[HTTP API] Credits deducted', {
                userId: req.user.id,
                tool: toolName,
                creditsDeducted: creditsRequired,
                newBalance: deduction.newBalance,
              });
            } else {
              logger.error('[HTTP API] Failed to deduct credits after execution', {
                userId: req.user.id,
                tool: toolName,
                creditsRequired,
                message: 'Balance was sufficient before execution but deduction failed',
              });
            }
          }
        } catch (creditError: any) {
          logger.error('[HTTP API] Error deducting credits', {
            userId: req.user.id,
            tool: toolName,
            error: creditError.message,
          });
        }
      }

      // 7. Return result with cost tracking info
      res.json({
        success: true,
        tool: toolName,
        service: route?.service || 'backend',
        result,
        cost_tracking: {
          request_id: requestId,
          estimate_before: estimate,
          actual_cost: breakdown,
        },
      });
    } catch (error: any) {
      logger.error('Tool call error:', error);

      const executionTime = Date.now() - startTime;
      try {
        await deps.costTracker.completeTrackingRecord({
          requestId,
          executionTimeMs: executionTime,
          status: 'failed',
          errorMessage: error.message,
        });
      } catch (trackingError) {
        logger.error('Failed to record error in cost tracking:', trackingError);
      }

      res.status(500).json({
        error: 'Tool execution failed',
        message: error.message,
        tool: req.params.toolName,
        cost_tracking: {
          request_id: requestId,
        },
      });
    }
  }) as any);

  return router;
}
