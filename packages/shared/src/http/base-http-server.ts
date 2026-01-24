import express, { Request, Response, NextFunction, Application } from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import { BaseDatabase } from '../database/base-database';
import { BaseCostTracker } from '../services/base-cost-tracker';
import { SSEEvent } from './sse-handler';
import {
  AuthenticatedRequest,
  HealthCheckResponse,
  ToolCallResponse,
} from '../types/http';

export interface BaseHTTPServerConfig {
  serviceName: string;
  version: string;
  port?: number;
  host?: string;
  allowedOrigins?: string[];
  enableCostTracking?: boolean;
}

export abstract class BaseHTTPServer {
  protected app: Application;
  protected config: BaseHTTPServerConfig;
  protected db?: BaseDatabase;
  protected costTracker?: BaseCostTracker;

  constructor(config: BaseHTTPServerConfig) {
    this.app = express();
    this.config = {
      port: parseInt(process.env.HTTP_PORT || '3000', 10),
      host: process.env.HTTP_HOST || '0.0.0.0',
      allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',') || ['*'],
      enableCostTracking: true,
      ...config,
    };

    this.setupMiddleware();
    this.setupBaseRoutes();
  }

  protected setupMiddleware(): void {
    this.app.use(cors({
      origin: this.config.allowedOrigins,
      credentials: true,
    }));

    this.app.use(express.json({
      limit: '10mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      },
    }));

    this.app.use((req, _res, next) => {
      logger.info('HTTP request', {
        method: req.method,
        path: req.path,
        ip: req.ip,
      });
      next();
    });
  }

  protected setupBaseRoutes(): void {
    this.app.get('/health', (_req, res) => {
      const response: HealthCheckResponse = {
        status: 'ok',
        service: this.config.serviceName,
        version: this.config.version,
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    });

    this.app.use((req, res) => {
      res.status(404).json({
        error: 'Not found',
        message: `Route ${req.method} ${req.path} not found`,
      });
    });

    this.app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      logger.error('Unhandled error:', err);
      res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred',
      });
    });
  }

  protected sendSSEEvent(res: Response, event: SSEEvent): void {
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

  protected async handleToolCallWithTracking(
    req: AuthenticatedRequest,
    res: Response,
    toolName: string,
    args: any,
    executeToolFn: (toolName: string, args: any) => Promise<any>
  ): Promise<void> {
    const requestId = uuidv4();
    const startTime = Date.now();

    try {
      logger.info('Tool call request', {
        requestId,
        tool: toolName,
        clientKey: req.clientKey?.substring(0, 8) + '...',
      });

      if (this.config.enableCostTracking && this.costTracker) {
        await this.costTracker.createTrackingRecord({
          requestId,
          toolName,
          clientKey: req.clientKey || 'unknown',
          userQuery: args.query || JSON.stringify(args),
          queryParams: args,
        });

        const estimate = await this.costTracker.estimateCost({
          toolName,
          queryLength: (args.query || '').length,
          reasoningBudget: args.reasoning_budget || 'standard',
        });

        logger.info('Cost estimate before execution', {
          requestId,
          toolName,
          estimate,
        });
      }

      const result = await executeToolFn(toolName, args);

      if (this.config.enableCostTracking && this.costTracker) {
        const executionTime = Date.now() - startTime;
        const breakdown = await this.costTracker.completeTrackingRecord({
          requestId,
          executionTimeMs: executionTime,
          status: 'completed',
        });

        logger.info('Request completed with cost tracking', {
          requestId,
          toolName,
          totalCostUsd: breakdown.totals.cost_usd.toFixed(6),
        });

        const response: ToolCallResponse = {
          success: true,
          tool: toolName,
          result,
          cost_tracking: {
            request_id: requestId,
            actual_cost: breakdown,
          },
        };

        res.json(response);
      } else {
        const response: ToolCallResponse = {
          success: true,
          tool: toolName,
          result,
        };
        res.json(response);
      }
    } catch (error: any) {
      logger.error('Tool call error:', error);

      if (this.config.enableCostTracking && this.costTracker) {
        const executionTime = Date.now() - startTime;
        try {
          await this.costTracker.completeTrackingRecord({
            requestId,
            executionTimeMs: executionTime,
            status: 'failed',
            errorMessage: error.message,
          });
        } catch (trackingError) {
          logger.error('Failed to record error in cost tracking:', trackingError);
        }
      }

      res.status(500).json({
        error: 'Tool execution failed',
        message: error.message,
        tool: toolName,
        cost_tracking: this.config.enableCostTracking
          ? { request_id: requestId }
          : undefined,
      });
    }
  }

  protected async handleStreamingToolCall(
    _req: AuthenticatedRequest,
    res: Response,
    toolName: string,
    args: any,
    executeToolFn: (toolName: string, args: any) => Promise<any>
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    this.sendSSEEvent(res, {
      type: 'connected',
      data: { tool: toolName, timestamp: new Date().toISOString() },
      id: 'connection',
    });

    try {
      this.sendSSEEvent(res, {
        type: 'progress',
        data: { message: 'Processing request...', progress: 0.3 },
        id: 'processing',
      });

      const result = await executeToolFn(toolName, args);

      this.sendSSEEvent(res, {
        type: 'progress',
        data: { message: 'Finalizing results...', progress: 0.9 },
        id: 'finalizing',
      });

      this.sendSSEEvent(res, {
        type: 'complete',
        data: result,
        id: 'final',
      });
    } catch (error: any) {
      this.sendSSEEvent(res, {
        type: 'error',
        data: {
          message: error.message,
          error: error.toString(),
        },
        id: 'error',
      });
    } finally {
      this.sendSSEEvent(res, {
        type: 'end',
        data: { message: 'Stream completed' },
        id: 'end',
      });
      res.end();
    }
  }

  abstract initialize(): Promise<void>;

  async start(): Promise<void> {
    await this.initialize();

    const port = this.config.port!;
    const host = this.config.host!;

    this.app.listen(port, host, () => {
      logger.info(`${this.config.serviceName} started on http://${host}:${port}`);
      logger.info('Available endpoints:');
      logger.info('  GET  /health - Health check');
      this.logAdditionalEndpoints();
    });
  }

  protected logAdditionalEndpoints(): void {
  }
}
