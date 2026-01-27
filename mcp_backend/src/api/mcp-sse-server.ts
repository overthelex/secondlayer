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
import { MCPQueryAPI } from './mcp-query-api.js';
import { LegislationTools } from './legislation-tools.js';
import { DocumentAnalysisTools } from './document-analysis-tools.js';

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

export class MCPSSEServer {
  constructor(
    private mcpAPI: MCPQueryAPI,
    private legislationTools: LegislationTools,
    private documentAnalysisTools: DocumentAnalysisTools
  ) {}

  /**
   * Get all available tools in MCP format
   */
  getAllTools(): MCPToolDefinition[] {
    const mcpTools = this.mcpAPI.getTools();
    const legislationToolsList = this.legislationTools.getToolDefinitions();
    const documentToolsList = this.documentAnalysisTools.getToolDefinitions();

    const allTools = [
      ...mcpTools,
      ...legislationToolsList,
      ...documentToolsList,
    ];

    // Convert to MCP format
    return allTools.map((tool: any) => ({
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
  async handleSSEConnection(req: Request, res: Response): Promise<void> {
    const sessionId = uuidv4();

    logger.info('[MCP SSE] New connection', {
      sessionId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Send initial connection event
    this.sendSSEMessage(res, {
      jsonrpc: '2.0',
      method: 'server/initialized',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
          prompts: {},
          resources: {},
        },
        serverInfo: {
          name: 'SecondLayer Legal MCP Server',
          version: '1.0.0',
        },
      },
    });

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
      logger.info('[MCP SSE] Connection closed', { sessionId });
    });

    // Process incoming messages from POST body
    if (req.body) {
      try {
        const mcpRequest = req.body as MCPRequest;
        await this.handleMCPRequest(res, mcpRequest, sessionId);
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
      }
    }

    // Don't end the connection - keep it open for SSE
    // The connection will be closed by client or timeout
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

    logger.info('[MCP SSE] Initialize', {
      clientInfo,
      protocolVersion: request.params?.protocolVersion,
    });

    this.sendSSEMessage(res, {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
          prompts: {},
          resources: {},
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
    const tools = this.getAllTools();

    logger.info('[MCP SSE] Tools list requested', {
      count: tools.length,
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

    logger.info('[MCP SSE] Tool call', {
      sessionId,
      tool: name,
      args: JSON.stringify(args).substring(0, 200),
    });

    try {
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

      // Execute tool
      let result;

      // Route to appropriate tool handler
      if (name.startsWith('get_legislation_') || name === 'search_legislation') {
        result = await this.executeLegislationTool(name, args);
      } else if (['parse_document', 'extract_key_clauses', 'summarize_document', 'compare_documents'].includes(name)) {
        result = await this.executeDocumentTool(name, args);
      } else {
        result = await this.mcpAPI.handleToolCall(name, args);
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
        error: error.message,
      });

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
   * Execute legislation tool
   */
  private async executeLegislationTool(name: string, args: any): Promise<any> {
    switch (name) {
      case 'get_legislation_article':
        return await this.legislationTools.getLegislationArticle(args);
      case 'get_legislation_section':
        return await this.legislationTools.getLegislationSection(args);
      case 'get_legislation_articles':
        return await this.legislationTools.getLegislationArticles(args);
      case 'search_legislation':
        return await this.legislationTools.searchLegislation(args);
      case 'get_legislation_structure':
        return await this.legislationTools.getLegislationStructure(args);
      default:
        throw new Error(`Unknown legislation tool: ${name}`);
    }
  }

  /**
   * Execute document analysis tool
   */
  private async executeDocumentTool(name: string, args: any): Promise<any> {
    switch (name) {
      case 'parse_document':
        return await this.documentAnalysisTools.parseDocument(args);
      case 'extract_key_clauses':
        return await this.documentAnalysisTools.extractKeyClauses(args);
      case 'summarize_document':
        return await this.documentAnalysisTools.summarizeDocument(args);
      case 'compare_documents':
        return await this.documentAnalysisTools.compareDocuments(args);
      default:
        throw new Error(`Unknown document tool: ${name}`);
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
      res.write(`data: ${data}\n\n`);
    } catch (error) {
      logger.error('[MCP SSE] Error sending message', { error });
    }
  }
}
