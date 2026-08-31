/**
 * MCP SSE Server for ChatGPT Web Integration
 *
 * Implements the Model Context Protocol (MCP) over Server-Sent Events (SSE)
 * for integration with ChatGPT web interface.
 *
 * Endpoint: https://mcp.legal.org.ua/sse
 *
 * Reference: https://platform.openai.com/docs/mcp
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import { ToolRegistry } from './tool-registry.js';
import { CostTracker } from '../services/cost-tracker.js';
import { CreditService } from '../services/credit-service.js';
import { requestContext } from '../utils/openai-client.js';
import { V2_TOOL_NAMES } from './curated-mcp-tools.js';

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: any;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface MCPNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}

interface SessionContext {
  userId?: string;
  clientKey?: string;
}

export class MCPSSEServer {
  private sessions: Map<string, SessionContext> = new Map();

  constructor(
    private toolRegistry: ToolRegistry,
    private costTracker: CostTracker,
    private creditService?: CreditService
  ) {}

  /**
   * Get all available tools in MCP format
   */
  getAllTools(): MCPToolDefinition[] {
    return this.toMcpFormat(this.toolRegistry.getLocalToolDefinitions());
  }

  /**
   * Local tools PLUS the proxied rada_* / openreyestr_* definitions.
   *
   * /sse could always EXECUTE prefixed tools — handleToolCall goes through
   * toolRegistry.executeTool, which proxies them — but it advertised only the local ones, so a
   * ChatGPT client never saw 23 of the 54 curated tools: the whole ЄДР surface (companies,
   * beneficiaries, debtors, Prozorro, РНБО, ФОП, tax/ЄСВ debt) and every parliament tool.
   * A client cannot call what it cannot see, so the endpoint looked like it lacked the
   * registries entirely.
   *
   * Falls back to the local list if the remote fetch fails, matching how the Streamable-HTTP
   * transport handles the same call (mcp-sse-routes.ts).
   */
  private async getAllToolsIncludingRemote(): Promise<MCPToolDefinition[]> {
    try {
      return this.toMcpFormat(await this.toolRegistry.getAllToolDefinitions());
    } catch (error: any) {
      logger.warn('[MCP SSE] Remote tool definitions unavailable; advertising local only', {
        error: error?.message,
      });
      return this.getAllTools();
    }
  }

  private toMcpFormat(tools: any[]): MCPToolDefinition[] {
    return tools.map((tool: any) => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema || {
        type: 'object',
        properties: {},
      },
    }));
  }

  /**
   * Handle MCP SSE connection
   * Main endpoint: POST /sse
   */
  async handleSSEConnection(
    req: Request,
    res: Response,
    userId?: string,
    clientKey?: string
  ): Promise<void> {
    const sessionId = uuidv4();

    // Store session context
    this.sessions.set(sessionId, { userId, clientKey });

    // Check Accept header — ChatGPT Streamable HTTP sends Accept: application/json
    const acceptHeader = req.headers.accept || '';

    logger.info('[MCP SSE] New connection', {
      sessionId,
      userId: userId || 'anonymous',
      clientKey: clientKey ? clientKey.substring(0, 8) + '...' : 'none',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      accept: acceptHeader,
      method: req.body?.method || 'unknown',
    });
    // POST = Streamable HTTP = always JSON response
    // GET = SSE transport = event-stream
    const wantsJson = req.method === 'POST';

    if (wantsJson) {
      // Streamable HTTP mode — respond with JSON
      res.setHeader('Content-Type', 'application/json');
    } else {
      // SSE mode
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
    }
    res.setHeader('Mcp-Session-Id', sessionId); // Required by MCP Streamable HTTP transport

    // Don't send server/initialized notification here
    // According to MCP spec, this notification is sent by CLIENT after receiving initialize response
    // OpenAI ChatGPT uses protocol versions 2025-03-26 or 2025-11-25

    // Keep connection alive with periodic pings
    const pingInterval = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(pingInterval);
        return;
      }
      res.write(': ping\n\n');
    }, 30000); // 30 seconds

    // Handle client disconnect
    req.on('close', () => {
      clearInterval(pingInterval);
      this.sessions.delete(sessionId);
      logger.info('[MCP SSE] Connection closed', { sessionId });
    });

    // Process incoming messages from POST body
    if (req.body && Object.keys(req.body).length > 0) {
      try {
        const mcpRequest = req.body as MCPRequest;

        // MCP notifications (no id) are fire-and-forget — accept silently
        if (mcpRequest.method?.startsWith('notifications/') || mcpRequest.id === undefined) {
          logger.debug('[MCP SSE] Received notification', {
            sessionId,
            method: mcpRequest.method,
          });
          clearInterval(pingInterval);
          if (!res.headersSent) {
            // Streamable HTTP: notifications get 202 Accepted with no body
            res.status(202).end();
          }
          return;
        }

        await this.handleMCPRequest(res, mcpRequest, sessionId);

        // OpenAI makes separate POST for each message, so close after response
        // Wait for SSE messages to be flushed (increased from 100ms to 1000ms to handle slow tools)
        setTimeout(() => {
          clearInterval(pingInterval);
          if (!res.writableEnded) {
            logger.info('[MCP SSE] Closing connection after response', { sessionId });
            res.end();
          }
        }, 1000);
      } catch (error: any) {
        logger.error('[MCP SSE] Error handling request', {
          sessionId,
          error: error.message,
        });
        this.sendSSEMessage(res, {
          jsonrpc: '2.0',
          id: (req.body as any)?.id || null,
          error: {
            code: -32603,
            message: 'Internal error',
            data: error.message,
          },
        });

        // Close on error too (increased timeout)
        setTimeout(() => {
          clearInterval(pingInterval);
          if (!res.writableEnded) {
            logger.info('[MCP SSE] Closing connection after error', { sessionId });
            res.end();
          }
        }, 1000);
      }
    } else {
      // No request body - just keep connection alive for long-polling
      // This will be closed by client or keepalive timeout
    }
  }

  /**
   * Handle individual MCP request
   */
  private async handleMCPRequest(
    res: Response,
    request: MCPRequest,
    sessionId: string
  ): Promise<void> {
    logger.info('[MCP SSE] Request received', {
      sessionId,
      method: request.method,
      id: request.id,
    });

    try {
      switch (request.method) {
        case 'initialize':
          await this.handleInitialize(res, request);
          break;

        case 'tools/list':
          await this.handleToolsList(res, request);
          break;

        case 'tools/call':
          await this.handleToolCall(res, request, sessionId);
          break;

        case 'prompts/list':
          await this.handlePromptsList(res, request);
          break;

        case 'resources/list':
          await this.handleResourcesList(res, request);
          break;

        case 'ping':
          this.sendSSEMessage(res, {
            jsonrpc: '2.0',
            id: request.id,
            result: { pong: true },
          });
          break;

        default:
          this.sendSSEMessage(res, {
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: -32601,
              message: `Method not found: ${request.method}`,
            },
          });
      }
    } catch (error: any) {
      logger.error('[MCP SSE] Error handling method', {
        sessionId,
        method: request.method,
        error: error.message,
      });
      this.sendSSEMessage(res, {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32603,
          message: 'Internal error',
          data: error.message,
        },
      });
    }
  }

  /**
   * Handle initialize request
   */
  private async handleInitialize(res: Response, request: MCPRequest): Promise<void> {
    const clientInfo = request.params?.clientInfo;
    const clientProtocolVersion = request.params?.protocolVersion;

    logger.info('[MCP SSE] Initialize', {
      clientInfo,
      protocolVersion: clientProtocolVersion,
    });

    // Use client's protocol version if it's newer than ours
    const supportedVersions = ['2024-11-05', '2025-11-05', '2025-03-26', '2025-11-25'];
    const protocolVersion = supportedVersions.includes(clientProtocolVersion)
      ? clientProtocolVersion
      : '2025-11-05';

    this.sendSSEMessage(res, {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion,
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        serverInfo: {
          name: 'SecondLayer Legal MCP Server',
          version: '1.0.0',
        },
      },
    });
  }

  /**
   * Handle tools/list request
   */
  private async handleToolsList(res: Response, request: MCPRequest): Promise<void> {
    const allTools = await this.getAllToolsIncludingRemote();

    // Advertise the curated v2 tool set — same whitelist as /api/v2/mcp — instead of
    // a blind slice(0, N). The previous slice kept only the first 15 tools by registration
    // order, which silently dropped the court-decision / ЄДРСР tools (registered later in
    // tool-services.ts) and made this endpoint unusable for case lookups. Filtering by an
    // explicit whitelist keeps the list small for ChatGPT while guaranteeing the right tools.
    const tools = allTools.filter((t) => V2_TOOL_NAMES.has(t.name));

    const missing = [...V2_TOOL_NAMES].filter((n) => !tools.some((t) => t.name === n));
    if (missing.length > 0) {
      logger.warn('[MCP SSE] Curated tools missing from local registry', { missing });
    }

    logger.info('[MCP SSE] Tools list requested', {
      count: tools.length,
      total: allTools.length,
    });

    this.sendSSEMessage(res, {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools,
      },
    });
  }

  /**
   * Handle tools/call request
   */
  private async handleToolCall(
    res: Response,
    request: MCPRequest,
    sessionId: string
  ): Promise<void> {
    const { name, arguments: args } = request.params || {};

    if (!name) {
      this.sendSSEMessage(res, {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32602,
          message: 'Invalid params: tool name is required',
        },
      });
      return;
    }

    // Get session context (userId, clientKey)
    const context = this.sessions.get(sessionId) || {};

    logger.info('[MCP SSE] Tool call', {
      sessionId,
      tool: name,
      userId: context.userId || 'anonymous',
      args: JSON.stringify(args).substring(0, 200),
    });

    const requestId = `sse-${request.id}-${Date.now()}`;
    const startTime = Date.now();

    try {
      // 1. Phase 2 Billing: Check credits BEFORE execution
      if (context.userId && this.creditService) {
        try {
          const creditsRequired = await this.creditService.calculateCreditsForTool(name, context.userId);

          if (creditsRequired > 0) {
            const balance = await this.creditService.checkBalance(context.userId, creditsRequired);

            if (!balance.hasCredits) {
              logger.warn('[MCP SSE] Insufficient credits, blocking request', {
                userId: context.userId,
                tool: name,
                creditsRequired,
                currentBalance: balance.currentBalance,
              });

              this.sendSSEMessage(res, {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                  code: -32000,
                  message: 'Insufficient credits',
                  data: {
                    code: 'INSUFFICIENT_CREDITS',
                    currentBalance: balance.currentBalance,
                    creditsRequired,
                    message: 'Your credit balance is too low to perform this operation. Please purchase more credits.',
                  },
                },
              });
              return;
            }

            logger.debug('[MCP SSE] Credit check passed', {
              userId: context.userId,
              tool: name,
              creditsRequired,
              currentBalance: balance.currentBalance,
            });
          } else {
            logger.debug('[MCP SSE] Free tier tool, no credit check needed', {
              userId: context.userId,
              tool: name,
            });
          }
        } catch (creditError: any) {
          logger.error('[MCP SSE] Error checking credits', {
            userId: context.userId,
            tool: name,
            error: creditError.message,
          });
          this.sendSSEMessage(res, {
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: -32000,
              message: 'Service temporarily unavailable',
              data: {
                code: 'BILLING_UNAVAILABLE',
                message: 'Credit check system is temporarily unavailable. Please try again later.',
              },
            },
          });
          return;
        }
      }

      // 2. Create cost tracking record
      await this.costTracker.createTrackingRecord({
        requestId,
        toolName: name,
        clientKey: context.clientKey,
        userId: context.userId,
        userQuery: args.query || JSON.stringify(args),
        queryParams: args,
      });

      // Send progress notification
      this.sendSSEMessage(res, {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: {
          progressToken: request.id,
          progress: 0,
          total: 100,
        },
      });

      // 3. Execute tool in request context
      const result = await requestContext.run(
        { requestId, task: name },
        async () => {
          const registryResult = await this.toolRegistry.executeTool(name, args);
          if (registryResult) return registryResult;
          throw new Error(`Unknown tool: ${name}`);
        }
      );

      // 4. Complete cost tracking
      const executionTime = Date.now() - startTime;
      await this.costTracker.completeTrackingRecord({
        requestId,
        executionTimeMs: executionTime,
        status: 'completed',
      });

      // 5. Phase 2 Billing: Deduct credits after successful execution
      if (context.userId && this.creditService) {
        try {
          const creditsRequired = await this.creditService.calculateCreditsForTool(name, context.userId);

          if (creditsRequired > 0) {
            const deduction = await this.creditService.deductCredits(
              context.userId,
              creditsRequired,
              name,
              requestId,
              `Tool execution: ${name}`
            );

            if (deduction.success) {
              logger.info('[MCP SSE] Credits deducted', {
                userId: context.userId,
                tool: name,
                creditsDeducted: creditsRequired,
                newBalance: deduction.newBalance,
              });
            } else {
              // This should not happen since we checked balance before execution
              // but log as error if it does (possible race condition)
              logger.error('[MCP SSE] Failed to deduct credits after execution', {
                userId: context.userId,
                tool: name,
                creditsRequired,
                message: 'Balance was sufficient before execution but deduction failed',
              });
            }
          } else {
            logger.debug('[MCP SSE] Free tier tool, no credits deducted', {
              userId: context.userId,
              tool: name,
            });
          }
        } catch (creditError: any) {
          logger.error('[MCP SSE] Error deducting credits', {
            userId: context.userId,
            tool: name,
            error: creditError.message,
          });
        }
      }

      // Send completion notification
      this.sendSSEMessage(res, {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: {
          progressToken: request.id,
          progress: 100,
          total: 100,
        },
      });

      // Send result
      logger.info('[MCP SSE] Sending tool result', {
        sessionId,
        tool: name,
        userId: context.userId || 'anonymous',
        resultSize: JSON.stringify(result).length,
        executionTimeMs: executionTime,
      });

      this.sendSSEMessage(res, {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: result.content || [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        },
      });

    } catch (error: any) {
      logger.error('[MCP SSE] Tool execution error', {
        sessionId,
        tool: name,
        userId: context.userId || 'anonymous',
        error: error.message,
      });

      // Record failure in cost tracking
      const executionTime = Date.now() - startTime;
      try {
        await this.costTracker.completeTrackingRecord({
          requestId,
          executionTimeMs: executionTime,
          status: 'failed',
          errorMessage: error.message,
        });
      } catch (trackingError) {
        logger.error('[MCP SSE] Failed to record error in cost tracking', { trackingError });
      }

      this.sendSSEMessage(res, {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32000,
          message: `Tool execution failed: ${error.message}`,
          data: {
            tool: name,
            error: error.toString(),
          },
        },
      });
    }
  }

  /**
   * Handle prompts/list request
   */
  private async handlePromptsList(res: Response, request: MCPRequest): Promise<void> {
    // No prompts currently supported
    this.sendSSEMessage(res, {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        prompts: [],
      },
    });
  }

  /**
   * Handle resources/list request
   */
  private async handleResourcesList(res: Response, request: MCPRequest): Promise<void> {
    // No resources currently supported
    this.sendSSEMessage(res, {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        resources: [],
      },
    });
  }

  /**
   * Send SSE message
   */
  private sendSSEMessage(res: Response, message: MCPResponse | MCPNotification): void {
    try {
      const data = JSON.stringify(message);

      // Check if client prefers JSON (Streamable HTTP) vs SSE
      // ChatGPT sends Accept: application/json and expects plain JSON-RPC response
      const contentType = res.getHeader('Content-Type') as string || '';
      if (contentType.includes('application/json')) {
        // Plain JSON response (Streamable HTTP mode)
        // Skip notifications — only send final result (messages with 'id')
        // Concatenating notifications + result creates invalid JSON
        if ('id' in message) {
          res.write(data);
        }
        // Notifications are silently dropped in JSON mode
      } else {
        // SSE format — all messages including notifications
        res.write(`event: message\ndata: ${data}\n\n`);
      }
    } catch (error) {
      logger.error('[MCP SSE] Error sending message', { error });
    }
  }
}
