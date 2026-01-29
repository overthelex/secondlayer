import EventSource from 'eventsource';

/**
 * SSE Event structure
 */
export interface SSEEvent {
  type: string;
  data: any;
  id?: string;
}

/**
 * SSEEventCollector - Utility class for collecting and managing SSE events in tests
 *
 * This class wraps an EventSource and provides methods to:
 * - Collect all events from the stream
 * - Wait for specific event types
 * - Wait for stream completion
 * - Filter events by type
 *
 * Usage:
 * ```typescript
 * const eventSource = new EventSource('http://localhost:3000/sse');
 * const collector = new SSEEventCollector(eventSource);
 *
 * // Wait for specific event
 * const completeEvent = await collector.waitForEvent('complete', 30000);
 *
 * // Wait for stream to complete
 * await collector.waitForComplete();
 *
 * // Get all collected events
 * const allEvents = collector.getAllEvents();
 * ```
 */
export class SSEEventCollector {
  private events: SSEEvent[] = [];
  private eventSource: EventSource;
  private eventListeners: Map<string, (e: MessageEvent) => void> = new Map();
  private completionPromise: Promise<void> | null = null;
  private resolveCompletion: (() => void) | null = null;

  /**
   * Event types that are commonly used in SSE streams
   */
  private static readonly COMMON_EVENT_TYPES = [
    'connected',
    'progress',
    'complete',
    'error',
    'end',
    'message', // Default EventSource event
  ];

  constructor(eventSource: EventSource) {
    this.eventSource = eventSource;
    this.setupListeners();
    this.setupCompletionPromise();
  }

  /**
   * Setup listeners for all common SSE event types
   */
  private setupListeners(): void {
    SSEEventCollector.COMMON_EVENT_TYPES.forEach(type => {
      const listener = (e: MessageEvent) => {
        try {
          const event: SSEEvent = {
            type,
            data: e.data ? JSON.parse(e.data) : null,
            id: (e as any).lastEventId || undefined,
          };
          this.events.push(event);

          // If this is an 'end' event, resolve completion promise
          if (type === 'end' && this.resolveCompletion) {
            this.resolveCompletion();
          }
        } catch (error) {
          // If JSON parsing fails, store raw data
          this.events.push({
            type,
            data: e.data,
            id: (e as any).lastEventId || undefined,
          });
        }
      };

      this.eventListeners.set(type, listener);
      this.eventSource.addEventListener(type, listener);
    });

    // Setup error listener
    this.eventSource.onerror = (error) => {
      this.events.push({
        type: 'error',
        data: { error: 'EventSource error', details: error },
      });

      // Resolve completion on error as well
      if (this.resolveCompletion) {
        this.resolveCompletion();
      }
    };
  }

  /**
   * Setup promise that resolves when stream completes
   */
  private setupCompletionPromise(): void {
    this.completionPromise = new Promise<void>((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  /**
   * Wait for a specific event type to be received
   *
   * @param type - Event type to wait for
   * @param timeout - Timeout in milliseconds (default: 30000)
   * @returns Promise that resolves with the event data
   * @throws Error if timeout is reached before event is received
   */
  async waitForEvent(type: string, timeout: number = 30000): Promise<any> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        // Check if event already exists
        const event = this.events.find(e => e.type === type);
        if (event) {
          clearInterval(checkInterval);
          resolve(event.data);
          return;
        }

        // Check timeout
        if (Date.now() - startTime > timeout) {
          clearInterval(checkInterval);
          reject(new Error(`Timeout waiting for event type: ${type}. Received events: ${this.events.map(e => e.type).join(', ')}`));
        }
      }, 100);
    });
  }

  /**
   * Wait for stream to complete (receive 'end' event or error)
   *
   * @param timeout - Timeout in milliseconds (default: 120000)
   * @returns Promise that resolves when stream completes
   * @throws Error if timeout is reached
   */
  async waitForComplete(timeout: number = 120000): Promise<void> {
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Timeout waiting for stream completion. Received ${this.events.length} events. Last event: ${this.events[this.events.length - 1]?.type}`));
      }, timeout);
    });

    return Promise.race([this.completionPromise!, timeoutPromise]);
  }

  /**
   * Get all collected events
   *
   * @returns Array of all collected SSE events
   */
  getAllEvents(): SSEEvent[] {
    return [...this.events];
  }

  /**
   * Get events filtered by type
   *
   * @param type - Event type to filter by
   * @returns Array of events matching the specified type
   */
  getEventsByType(type: string): SSEEvent[] {
    return this.events.filter(e => e.type === type);
  }

  /**
   * Get the count of events by type
   *
   * @returns Map of event type to count
   */
  getEventCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    this.events.forEach(event => {
      counts.set(event.type, (counts.get(event.type) || 0) + 1);
    });
    return counts;
  }

  /**
   * Get the last event received
   *
   * @returns Last event or undefined if no events
   */
  getLastEvent(): SSEEvent | undefined {
    return this.events[this.events.length - 1];
  }

  /**
   * Clear all collected events
   */
  clear(): void {
    this.events = [];
  }

  /**
   * Close the EventSource and cleanup listeners
   */
  close(): void {
    this.eventListeners.forEach((listener, type) => {
      this.eventSource.removeEventListener(type, listener);
    });
    this.eventListeners.clear();
    this.eventSource.close();
  }

  /**
   * Get event at specific index
   *
   * @param index - Index of the event
   * @returns Event at the specified index or undefined
   */
  getEventAt(index: number): SSEEvent | undefined {
    return this.events[index];
  }

  /**
   * Check if a specific event type has been received
   *
   * @param type - Event type to check
   * @returns True if event type has been received
   */
  hasEvent(type: string): boolean {
    return this.events.some(e => e.type === type);
  }

  /**
   * Wait for multiple events in sequence
   *
   * @param types - Array of event types to wait for in order
   * @param timeout - Timeout for each event in milliseconds
   * @returns Promise that resolves with array of event data
   */
  async waitForSequence(types: string[], timeout: number = 30000): Promise<any[]> {
    const results: any[] = [];
    for (const type of types) {
      const data = await this.waitForEvent(type, timeout);
      results.push(data);
    }
    return results;
  }

  /**
   * Get progress events in order
   * Useful for testing streaming tools like get_legal_advice
   *
   * @returns Array of progress events
   */
  getProgressEvents(): SSEEvent[] {
    return this.events.filter(e => e.type === 'progress');
  }

  /**
   * Validate progress events have monotonically increasing progress values
   *
   * @returns True if progress values increase, false otherwise
   */
  validateProgressSequence(): boolean {
    const progressEvents = this.getProgressEvents();
    if (progressEvents.length === 0) return true;

    let lastProgress = -1;
    for (const event of progressEvents) {
      const progress = event.data?.progress || 0;
      if (progress < lastProgress) {
        return false;
      }
      lastProgress = progress;
    }
    return true;
  }
}
