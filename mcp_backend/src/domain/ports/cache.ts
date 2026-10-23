/**
 * Cache port interface.
 *
 * Abstracts Redis (or any key-value store) behind a minimal surface.
 */

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface ICachePort {
  /** Retrieve a value by key. Returns `null` when the key does not exist. */
  get(key: string): Promise<string | null>;

  /**
   * Store a value.
   * When `ttlSeconds` is provided the key expires automatically;
   * otherwise it persists until explicitly deleted.
   */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;

  /** Delete one or more keys. */
  del(...keys: string[]): Promise<number>;

  /**
   * Atomically increment a counter and set its TTL (if not already set).
   * Returns the new counter value.
   *
   * This abstracts the common rate-limiting pattern:
   *   MULTI → INCR key → EXPIRE key ttl → EXEC
   *
   * `by` (default 1) adds more than one in the same transaction (INCRBY).
   */
  increment(key: string, ttlSeconds: number, by?: number): Promise<number>;

  /** Connectivity check. */
  ping(): Promise<boolean>;

  /** Whether the underlying connection is currently open. */
  isConnected(): boolean;

  /** Open the connection (idempotent). */
  connect(): Promise<void>;

  /** Close the connection gracefully. */
  disconnect(): Promise<void>;
}
