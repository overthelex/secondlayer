import { Response } from 'express';

/**
 * SSE Event structure for parsing
 */
interface ParsedSSEEvent {
  type?: string;
  data?: any;
  id?: string;
}

/**
 * MockSSEResponse - Mock Express Response for SSE testing
 *
 * This class mocks the Express Response object for unit testing SSE endpoints.
 * It captures all write() calls, headers, and provides methods to parse SSE events.
 *
 * Usage:
 * ```typescript
 * const mockRes = new MockSSEResponse();
 * await handleStreamingToolCall(mockReq, mockRes as any, 'get_legal_advice', args);
 *
 * // Verify headers
 * expect(mockRes.getHeader('Content-Type')).toBe('text/event-stream');
 *
 * // Parse events
 * const events = mockRes.parseEvents();
 * expect(events).toHaveLength(10);
 * expect(events[0].type).toBe('connected');
 * ```
 */
export class MockSSEResponse {
  public headers: Map<string, string> = new Map();
  public chunks: string[] = [];
  public ended: boolean = false;
  public headersSent: boolean = false;
  public statusCode: number = 200;
  private writeCallbacks: Array<() => void> = [];

  /**
   * Mock setHeader method
   */
  setHeader(name: string, value: string): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  /**
   * Mock getHeader method
   */
  getHeader(name: string): string | undefined {
    return this.headers.get(name.toLowerCase());
  }

  /**
   * Mock write method
   */
  write(chunk: string | Buffer): boolean {
    this.headersSent = true;
    const chunkStr = typeof chunk === 'string' ? chunk : chunk.toString();
    this.chunks.push(chunkStr);

    // Execute any write callbacks (for async testing)
    this.writeCallbacks.forEach(cb => cb());

    return true;
  }

  /**
   * Mock end method
   */
  end(chunk?: string | Buffer): this {
    if (chunk) {
      this.write(chunk);
    }
    this.ended = true;
    return this;
  }

  /**
   * Mock status method
   */
  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  /**
   * Mock json method
   */
  json(body: any): this {
    this.setHeader('content-type', 'application/json');
    this.write(JSON.stringify(body));
    this.end();
    return this;
  }

  /**
   * Mock send method
   */
  send(body: any): this {
    if (typeof body === 'object') {
      return this.json(body);
    }
    this.write(String(body));
    this.end();
    return this;
  }

  /**
   * Parse all SSE events from the written chunks
   *
   * Follows SSE format:
   * ```
   * id: event-id
   * event: event-type
   * data: {"json": "data"}
   *
   * ```
   *
   * @returns Array of parsed SSE events
   */
  parseEvents(): ParsedSSEEvent[] {
    const events: ParsedSSEEvent[] = [];
    let currentEvent: ParsedSSEEvent = {};

    // Combine all chunks into single string
    const fullText = this.chunks.join('');

    // Split by lines
    const lines = fullText.split('\n');

    for (const line of lines) {
      if (line.startsWith('id: ')) {
        currentEvent.id = line.substring(4).trim();
      } else if (line.startsWith('event: ')) {
        currentEvent.type = line.substring(7).trim();
      } else if (line.startsWith('data: ')) {
        const dataStr = line.substring(6).trim();
        try {
          currentEvent.data = JSON.parse(dataStr);
        } catch {
          // If not JSON, store as string
          currentEvent.data = dataStr;
        }
      } else if (line.trim() === '') {
        // Empty line signals end of event
        if (Object.keys(currentEvent).length > 0) {
          events.push(currentEvent);
          currentEvent = {};
        }
      } else if (line.startsWith(':')) {
        // Comment line (e.g., ": ping") - ignore or track separately
        if (line.trim() === ': ping') {
          events.push({ type: 'ping', data: null });
        }
      }
    }

    // Add last event if exists
    if (Object.keys(currentEvent).length > 0) {
      events.push(currentEvent);
    }

    return events;
  }

  /**
   * Get events filtered by type
   *
   * @param type - Event type to filter
   * @returns Array of events matching the type
   */
  getEventsByType(type: string): ParsedSSEEvent[] {
    return this.parseEvents().filter(e => e.type === type);
  }

  /**
   * Get the count of events by type
   *
   * @returns Map of event type to count
   */
  getEventCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    this.parseEvents().forEach(event => {
      const type = event.type || 'unknown';
      counts.set(type, (counts.get(type) || 0) + 1);
    });
    return counts;
  }

  /**
   * Wait for a specific number of write calls
   * Useful for async testing
   *
   * @param count - Number of write calls to wait for
   * @param timeout - Timeout in milliseconds
   * @returns Promise that resolves when count is reached
   */
  async waitForWrites(count: number, timeout: number = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const checkWrites = () => {
        if (this.chunks.length >= count) {
          resolve();
          return true;
        }
        return false;
      };

      // Check immediately
      if (checkWrites()) return;

      // Setup callback for future writes
      const callback = () => {
        checkWrites();
      };
      this.writeCallbacks.push(callback);

      // Setup timeout
      setTimeout(() => {
        const index = this.writeCallbacks.indexOf(callback);
        if (index > -1) {
          this.writeCallbacks.splice(index, 1);
        }
        reject(new Error(`Timeout waiting for ${count} writes. Got ${this.chunks.length}`));
      }, timeout);
    });
  }

  /**
   * Get all written content as single string
   *
   * @returns All chunks concatenated
   */
  getFullContent(): string {
    return this.chunks.join('');
  }

  /**
   * Verify that required SSE headers are set correctly
   *
   * @returns True if all required headers are present
   */
  verifySSEHeaders(): boolean {
    const contentType = this.getHeader('content-type');
    const cacheControl = this.getHeader('cache-control');
    const connection = this.getHeader('connection');

    return (
      contentType === 'text/event-stream' &&
      cacheControl !== undefined &&
      cacheControl.includes('no-cache') &&
      connection === 'keep-alive'
    );
  }

  /**
   * Get the first event of a specific type
   *
   * @param type - Event type
   * @returns First event matching type or undefined
   */
  getFirstEventOfType(type: string): ParsedSSEEvent | undefined {
    return this.parseEvents().find(e => e.type === type);
  }

  /**
   * Get the last event of a specific type
   *
   * @param type - Event type
   * @returns Last event matching type or undefined
   */
  getLastEventOfType(type: string): ParsedSSEEvent | undefined {
    const events = this.getEventsByType(type);
    return events[events.length - 1];
  }

  /**
   * Check if a specific event type exists
   *
   * @param type - Event type to check
   * @returns True if at least one event of this type exists
   */
  hasEventType(type: string): boolean {
    return this.parseEvents().some(e => e.type === type);
  }

  /**
   * Reset the mock response (clear all state)
   */
  reset(): void {
    this.headers.clear();
    this.chunks = [];
    this.ended = false;
    this.headersSent = false;
    this.statusCode = 200;
    this.writeCallbacks = [];
  }

  /**
   * Get progress events in order
   * Useful for validating streaming sequences
   *
   * @returns Array of progress events
   */
  getProgressEvents(): ParsedSSEEvent[] {
    return this.getEventsByType('progress');
  }

  /**
   * Validate that events appear in expected order
   *
   * @param expectedSequence - Array of expected event types in order
   * @returns True if sequence matches
   */
  validateEventSequence(expectedSequence: string[]): boolean {
    const events = this.parseEvents();
    if (events.length < expectedSequence.length) return false;

    for (let i = 0; i < expectedSequence.length; i++) {
      if (events[i].type !== expectedSequence[i]) {
        return false;
      }
    }
    return true;
  }

  /**
   * Create a mock Response object compatible with Express
   * Useful for passing to handlers that expect Response type
   *
   * @returns Partial Express Response object
   */
  asExpressResponse(): Partial<Response> {
    return {
      setHeader: this.setHeader.bind(this) as any,
      getHeader: this.getHeader.bind(this) as any,
      write: this.write.bind(this) as any,
      end: this.end.bind(this) as any,
      status: this.status.bind(this) as any,
      json: this.json.bind(this) as any,
      send: this.send.bind(this) as any,
      headersSent: this.headersSent,
    } as any;
  }
}
