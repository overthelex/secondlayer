import { Response } from 'express';
import { logger } from '../utils/logger';

export interface SSEEvent {
  type: string;
  data: any;
  id?: string;
}

export class SSEHandler {
  static sendEvent(res: Response, event: SSEEvent): void {
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

  static setupHeaders(res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
  }

  static sendConnected(res: Response, toolName: string): void {
    this.sendEvent(res, {
      type: 'connected',
      data: { tool: toolName, timestamp: new Date().toISOString() },
      id: 'connection',
    });
  }

  static sendProgress(res: Response, message: string, progress: number, id?: string): void {
    this.sendEvent(res, {
      type: 'progress',
      data: { message, progress },
      id: id || 'progress',
    });
  }

  static sendComplete(res: Response, data: any): void {
    this.sendEvent(res, {
      type: 'complete',
      data,
      id: 'final',
    });
  }

  static sendError(res: Response, error: Error | string): void {
    const message = typeof error === 'string' ? error : error.message;
    const errorStr = typeof error === 'string' ? error : error.toString();
    
    this.sendEvent(res, {
      type: 'error',
      data: { message, error: errorStr },
      id: 'error',
    });
  }

  static sendEnd(res: Response): void {
    this.sendEvent(res, {
      type: 'end',
      data: { message: 'Stream completed' },
      id: 'end',
    });
    res.end();
  }
}
