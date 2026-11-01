/**
 * EdsrCacheService — Read-through Redis cache for EDRSR court decisions.
 *
 * Provides caching for:
 * - Full text of decisions (TTL 24h) — key: edrsr:ft:{docId}
 * - Document metadata (TTL 24h)     — key: edrsr:meta:{docId}
 * - FTS search results (TTL 1h)     — key: edrsr:fts:{queryHash}
 *
 * Uses existing ICachePort (Redis adapter) — no new infrastructure required.
 * Graceful degradation: all methods return null on cache miss or error,
 * allowing callers to fall back to PostgreSQL seamlessly.
 */

import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';
import type { ICachePort } from '../domain/ports/index.js';

// TTL constants (seconds)
const FULLTEXT_TTL = 86400;  // 24 hours
const METADATA_TTL = 86400;  // 24 hours
const FTS_TTL = 3600;        // 1 hour

// Key prefixes
const KEY_FULLTEXT = 'edrsr:ft:';
const KEY_METADATA = 'edrsr:meta:';
const KEY_FTS = 'edrsr:fts:';

export type CacheMetricsCallback = (operation: string, result: 'hit' | 'miss') => void;

export class EdsrCacheService {
  private metricsCallback?: CacheMetricsCallback;

  constructor(private cache: ICachePort) {}

  setMetricsCallback(cb: CacheMetricsCallback): void {
    this.metricsCallback = cb;
  }

  // ── Fulltext ─────────────────────────────────────────────────────────────

  async getCachedFulltext(docId: number): Promise<string | null> {
    try {
      const result = await this.cache.get(`${KEY_FULLTEXT}${docId}`);
      this.metricsCallback?.('fulltext', result ? 'hit' : 'miss');
      return result;
    } catch (err: any) {
      logger.debug('[EdsrCache] getCachedFulltext error', { docId, error: err.message });
      this.metricsCallback?.('fulltext', 'miss');
      return null;
    }
  }

  async setCachedFulltext(docId: number, text: string): Promise<void> {
    try {
      await this.cache.set(`${KEY_FULLTEXT}${docId}`, text, FULLTEXT_TTL);
    } catch (err: any) {
      logger.debug('[EdsrCache] setCachedFulltext error', { docId, error: err.message });
    }
  }

  // ── Metadata ─────────────────────────────────────────────────────────────

  async getCachedMetadata(docId: number): Promise<any | null> {
    try {
      const raw = await this.cache.get(`${KEY_METADATA}${docId}`);
      this.metricsCallback?.('metadata', raw ? 'hit' : 'miss');
      return raw ? JSON.parse(raw) : null;
    } catch (err: any) {
      logger.debug('[EdsrCache] getCachedMetadata error', { docId, error: err.message });
      this.metricsCallback?.('metadata', 'miss');
      return null;
    }
  }

  async setCachedMetadata(docId: number, meta: any): Promise<void> {
    try {
      await this.cache.set(`${KEY_METADATA}${docId}`, JSON.stringify(meta), METADATA_TTL);
    } catch (err: any) {
      logger.debug('[EdsrCache] setCachedMetadata error', { docId, error: err.message });
    }
  }

  // ── FTS Results ──────────────────────────────────────────────────────────

  async getCachedFtsResults(query: string, filters: Record<string, any> = {}, limit: number, offset: number): Promise<any | null> {
    try {
      const hash = this.hashFtsQuery(query, filters, limit, offset);
      const raw = await this.cache.get(`${KEY_FTS}${hash}`);
      this.metricsCallback?.('fts', raw ? 'hit' : 'miss');
      return raw ? JSON.parse(raw) : null;
    } catch (err: any) {
      logger.debug('[EdsrCache] getCachedFtsResults error', { error: err.message });
      this.metricsCallback?.('fts', 'miss');
      return null;
    }
  }

  async setCachedFtsResults(query: string, filters: Record<string, any> = {}, limit: number, offset: number, results: any): Promise<void> {
    try {
      const hash = this.hashFtsQuery(query, filters, limit, offset);
      await this.cache.set(`${KEY_FTS}${hash}`, JSON.stringify(results), FTS_TTL);
    } catch (err: any) {
      logger.debug('[EdsrCache] setCachedFtsResults error', { error: err.message });
    }
  }

  // ── Generic JSON (namespaced, caller-chosen TTL) ─────────────────────────

  /** key: edrsr:{ns}:{sha256(key)[0..16]} — e.g. countByParty year legs (LEXAI-2177). */
  async getCachedJson(ns: string, key: string): Promise<any | null> {
    try {
      const raw = await this.cache.get(`edrsr:${ns}:${this.hashKey(key)}`);
      this.metricsCallback?.(ns, raw ? 'hit' : 'miss');
      return raw ? JSON.parse(raw) : null;
    } catch (err: any) {
      logger.debug('[EdsrCache] getCachedJson error', { ns, error: err.message });
      this.metricsCallback?.(ns, 'miss');
      return null;
    }
  }

  async setCachedJson(ns: string, key: string, value: any, ttlSeconds: number): Promise<void> {
    try {
      await this.cache.set(`edrsr:${ns}:${this.hashKey(key)}`, JSON.stringify(value), ttlSeconds);
    } catch (err: any) {
      logger.debug('[EdsrCache] setCachedJson error', { ns, error: err.message });
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 16);
  }

  private hashFtsQuery(query: string, filters: Record<string, any>, limit: number, offset: number): string {
    const input = JSON.stringify({ q: query, f: filters, l: limit, o: offset });
    return createHash('sha256').update(input).digest('hex').slice(0, 16);
  }
}
