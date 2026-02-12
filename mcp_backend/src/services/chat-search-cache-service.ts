/**
 * ChatSearchCacheService — Redis caching for court search tool results
 * executed during the ChatService agentic loop.
 *
 * Responsibilities:
 * 1. Cache query-level results in Redis (30 min TTL)
 * 2. Extract doc_ids from various court tool result formats
 * 3. Trigger background full-text downloads for discovered documents
 */

import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { getRedisClient } from '../utils/redis-client.js';
import { ZOAdapter } from '../adapters/zo-adapter.js';
import { DocumentService } from './document-service.js';

const CACHE_TTL = parseInt(process.env.CHAT_SEARCH_CACHE_TTL || '1800', 10); // 30 min
const MAX_DOCS_PER_CALL = 10;
const DOWNLOAD_CONCURRENCY = 3;

/** Court search tools whose results should be cached & whose docs should be pre-fetched */
const COURT_SEARCH_TOOLS = new Set([
  'search_legal_precedents',
  'search_supreme_court_practice',
  'find_similar_fact_pattern_cases',
  'compare_practice_pro_contra',
  'get_case_documents_chain',
  'count_cases_by_party',
]);

export function isCourtSearchTool(toolName: string): boolean {
  return COURT_SEARCH_TOOLS.has(toolName);
}

export class ChatSearchCacheService {
  constructor(
    private zoAdapter: ZOAdapter,
    private documentService: DocumentService
  ) {}

  // ─── Query-level cache ───────────────────────────────────────

  private cacheKey(toolName: string, args: Record<string, any>): string {
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify(args))
      .digest('hex')
      .slice(0, 16);
    return `chat:search:${toolName}:${hash}`;
  }

  async getCachedResult(toolName: string, args: Record<string, any>): Promise<any | null> {
    try {
      const redis = await getRedisClient();
      if (!redis) return null;

      const raw = await redis.get(this.cacheKey(toolName, args));
      if (!raw) return null;

      logger.info('[ChatSearchCache] Cache hit', { toolName });
      return JSON.parse(raw);
    } catch (err: any) {
      logger.warn('[ChatSearchCache] getCachedResult error', { error: err.message });
      return null;
    }
  }

  async cacheResult(toolName: string, args: Record<string, any>, result: any): Promise<void> {
    try {
      const redis = await getRedisClient();
      if (!redis) return;

      await redis.setEx(
        this.cacheKey(toolName, args),
        CACHE_TTL,
        JSON.stringify(result)
      );
      logger.debug('[ChatSearchCache] Cached result', { toolName, ttl: CACHE_TTL });
    } catch (err: any) {
      logger.warn('[ChatSearchCache] cacheResult error', { error: err.message });
    }
  }

  // ─── Doc ID extraction ───────────────────────────────────────

  /**
   * Extract doc_ids from any court tool result shape.
   * Tool results are wrapped: { content: [{ type: 'text', text: JSON.stringify(data) }] }
   */
  extractDocIds(result: any): string[] {
    const ids = new Set<string>();

    const addId = (v: any) => {
      if (v !== undefined && v !== null) ids.add(String(v));
    };

    const walkArray = (arr: any[]) => {
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        addId(item.doc_id);
        addId(item.document_id);
        addId(item.zakononline_id);
        addId(item.id);
      }
    };

    try {
      // Unwrap MCP content envelope
      let data = result;
      if (data?.content && Array.isArray(data.content)) {
        for (const block of data.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            try {
              data = JSON.parse(block.text);
            } catch {
              continue;
            }
            break;
          }
        }
      }

      if (typeof data !== 'object' || data === null) return [];

      // results[] — search_legal_precedents, search_court_cases, etc.
      if (Array.isArray(data.results)) walkArray(data.results);
      // similar_cases[] — find_similar_fact_pattern_cases
      if (Array.isArray(data.similar_cases)) walkArray(data.similar_cases);
      // source_case — find_similar_fact_pattern_cases
      if (data.source_case) walkArray([data.source_case]);
      // pro[] / contra[] — compare_practice_pro_contra
      if (Array.isArray(data.pro)) walkArray(data.pro);
      if (Array.isArray(data.contra)) walkArray(data.contra);
      // documents[] — get_case_documents_chain
      if (Array.isArray(data.documents)) walkArray(data.documents);
      // grouped_documents{} — get_case_documents_chain (grouped variant)
      if (data.grouped_documents && typeof data.grouped_documents === 'object') {
        for (const group of Object.values(data.grouped_documents)) {
          if (Array.isArray(group)) walkArray(group);
        }
      }
      // cases[] — count_cases_by_party
      if (Array.isArray(data.cases)) walkArray(data.cases);
    } catch (err: any) {
      logger.warn('[ChatSearchCache] extractDocIds error', { error: err.message });
    }

    return Array.from(ids).slice(0, MAX_DOCS_PER_CALL);
  }

  // ─── Background full-text download ──────────────────────────

  /**
   * Fire-and-forget: download full text for documents that don't have it yet.
   */
  triggerBackgroundDownloads(docIds: string[]): void {
    if (docIds.length === 0) return;

    setImmediate(async () => {
      try {
        await this.downloadFullTexts(docIds);
      } catch (err: any) {
        logger.warn('[ChatSearchCache] Background download error', { error: err.message });
      }
    });
  }

  private async downloadFullTexts(docIds: string[]): Promise<void> {
    // Filter to docs that don't already have full_text
    const needsDownload: string[] = [];
    for (const docId of docIds) {
      try {
        const doc = await this.documentService.getDocumentByZoId(docId);
        if (!doc || !doc.full_text) {
          needsDownload.push(docId);
        }
      } catch {
        // If check fails, skip this doc
      }
    }

    if (needsDownload.length === 0) {
      logger.debug('[ChatSearchCache] All docs already have full text');
      return;
    }

    logger.info('[ChatSearchCache] Downloading full text for docs', {
      count: needsDownload.length,
      docIds: needsDownload,
    });

    // Process in batches of DOWNLOAD_CONCURRENCY
    for (let i = 0; i < needsDownload.length; i += DOWNLOAD_CONCURRENCY) {
      const batch = needsDownload.slice(i, i + DOWNLOAD_CONCURRENCY);
      await Promise.allSettled(
        batch.map((docId) => this.downloadOne(docId))
      );
    }
  }

  private async downloadOne(docId: string): Promise<void> {
    try {
      const fullTextData = await this.zoAdapter.getDocumentFullText(docId);
      if (!fullTextData || !fullTextData.text) return;

      await this.documentService.updateFullText(docId, fullTextData.text);
      logger.debug('[ChatSearchCache] Saved full text', { docId, len: fullTextData.text.length });
    } catch (err: any) {
      logger.warn('[ChatSearchCache] Failed to download doc', { docId, error: err.message });
    }
  }
}
