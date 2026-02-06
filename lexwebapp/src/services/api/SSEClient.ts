/**
 * SSE Client Service
 * Universal client for Server-Sent Events streaming from MCP backend
 * Uses Fetch API + ReadableStream for better control than EventSource
 */

import {
  SSEEvent,
  SSEEventType,
  StreamingCallbacks,
  SSEProgressEvent,
  SSECompleteEvent,
  SSEErrorEvent,
} from '../../types/api/sse';

export class SSEClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly maxRetries: number = 3;

  constructor(apiUrl: string, apiKey: string) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
  }

  /**
   * Stream a tool execution with SSE
   * @param toolName - Name of the MCP tool to execute
   * @param params - Parameters for the tool
   * @param handlers - Callback handlers for different SSE events
   * @returns AbortController to cancel the stream
   */
  async streamTool(
    toolName: string,
    params: any,
    handlers: StreamingCallbacks
  ): Promise<AbortController> {
    const controller = new AbortController();
    const url = `${this.apiUrl}/tools/${toolName}/stream`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(params),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `SSE stream failed: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      if (!response.body) {
        throw new Error('Response body is null');
      }

      // Process the stream
      this.processStream(response.body, handlers, controller);
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('Stream cancelled by user');
      } else {
        console.error('SSE stream error:', error);
        handlers.onError?.({
          message: error.message || 'Stream connection failed',
          error,
        });
      }
    }

    return controller;
  }

  /**
   * Process the SSE stream
   */
  private async processStream(
    body: ReadableStream<Uint8Array>,
    handlers: StreamingCallbacks,
    controller: AbortController
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          handlers.onEnd?.();
          break;
        }

        // Decode the chunk and add to buffer
        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE messages
        const messages = buffer.split('\n\n');
        buffer = messages.pop() || ''; // Keep incomplete message in buffer

        for (const message of messages) {
          if (message.trim() === '') continue;

          try {
            const event = this.parseSSEMessage(message);
            if (event) {
              this.handleSSEEvent(event, handlers);
            }
          } catch (error) {
            console.error('Failed to parse SSE message:', error, message);
          }
        }
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('Stream reading cancelled');
      } else {
        console.error('Stream reading error:', error);
        handlers.onError?.({
          message: 'Stream reading failed',
          error,
        });
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Parse SSE message format
   * Format: event: <type>\ndata: <json>\n\n
   */
  private parseSSEMessage(message: string): SSEEvent | null {
    const lines = message.split('\n');
    let event: SSEEventType = 'progress';
    let data: any = null;
    let id: string | undefined;

    for (const line of lines) {
      if (line.startsWith('event:')) {
        event = line.substring(6).trim() as SSEEventType;
      } else if (line.startsWith('data:')) {
        const dataStr = line.substring(5).trim();
        try {
          data = JSON.parse(dataStr);
        } catch (error) {
          // If not JSON, use as plain string
          data = dataStr;
        }
      } else if (line.startsWith('id:')) {
        id = line.substring(3).trim();
      }
    }

    if (data === null) {
      return null;
    }

    return { id, event, data };
  }

  /**
   * Handle different SSE event types
   */
  private handleSSEEvent(event: SSEEvent, handlers: StreamingCallbacks): void {
    switch (event.event) {
      case 'connected':
        handlers.onConnected?.(event.data);
        break;

      case 'progress':
        handlers.onProgress?.(event.data as SSEProgressEvent);
        break;

      case 'complete':
        handlers.onComplete?.(event.data as SSECompleteEvent);
        break;

      case 'error':
        handlers.onError?.(event.data as SSEErrorEvent);
        break;

      case 'end':
        handlers.onEnd?.();
        break;

      default:
        console.warn('Unknown SSE event type:', event.event);
    }
  }

  /**
   * Stream with automatic retry on failure
   */
  async streamToolWithRetry(
    toolName: string,
    params: any,
    handlers: StreamingCallbacks,
    retryCount: number = 0
  ): Promise<AbortController> {
    try {
      return await this.streamTool(toolName, params, {
        ...handlers,
        onError: (error) => {
          // Retry on error if under max retries
          if (retryCount < this.maxRetries) {
            console.log(`Retrying stream (${retryCount + 1}/${this.maxRetries})...`);
            setTimeout(() => {
              this.streamToolWithRetry(toolName, params, handlers, retryCount + 1);
            }, 1000 * Math.pow(2, retryCount)); // Exponential backoff
          } else {
            handlers.onError?.(error);
          }
        },
      });
    } catch (error: any) {
      if (retryCount < this.maxRetries) {
        console.log(`Retrying stream (${retryCount + 1}/${this.maxRetries})...`);
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * Math.pow(2, retryCount))
        );
        return this.streamToolWithRetry(toolName, params, handlers, retryCount + 1);
      }
      throw error;
    }
  }
}
