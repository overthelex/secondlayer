/**
 * EdsrVectorizerService — On-demand vectorization of EDRSR court decisions.
 *
 * When a search returns EDRSR doc_ids, this service checks if they have vectors
 * in Qdrant. If not, it fetches fulltext from PG, chunks, embeds with BGE-M3
 * in parallel batches, and stores in a dedicated `edrsr_decisions` Qdrant collection.
 *
 * Uses BGE-M3 (1024-dim) via self-hosted HuggingFace TEI endpoint.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { BgeM3Client, EmbeddingBatchResult } from '../utils/bge-m3-client.js';
import { logger } from '../utils/logger.js';
import { Semaphore } from '../utils/semaphore.js';
import { v4 as uuidv4 } from 'uuid';

// ── Constants ────────────────────────────────────────────────────────────────

const EMBEDDING_DIM = 1024;
const EMBEDDING_MODEL = 'bge-m3';
// Default to the live collection. `edrsr_serving` — the previous default — has
// not existed since the qdrant.lex node was terminated (2026-07-05); leaving it
// as the fallback meant a missing env var sent every search at a collection that
// is gone, and semantic search silently returned nothing.
const COLLECTION_NAME = process.env.QDRANT_EDRSR_COLLECTION || 'edrsr_decisions';
const EMBED_BATCH_SIZE = 64; // TEI supports larger batches than VoyageAI
const QDRANT_UPSERT_BATCH = 100; // Qdrant upsert sub-batch
const DEFAULT_CONCURRENCY = 5;
// Cap concurrent Qdrant searches against the serving collection (LEXAI-1758). Each
// search fans across every segment (44 as of 2026-08-11); too many in flight saturates the
// serving node's cores and blows the request timeout (aborts → hybrid loses its
// vector leg). Tunable via env.
const QDRANT_SEARCH_CONCURRENCY = Math.max(1, Number(process.env.QDRANT_EDRSR_MAX_CONCURRENCY || 2));

/** Minimal async semaphore — bounds in-flight work to `max` concurrent runs. */
export class AsyncSemaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
const MAX_CHUNK_CHARS = 2048;
const CHUNK_OVERLAP_WORDS = 50;

// ── Types ────────────────────────────────────────────────────────────────────

export interface EdrsrDocument {
  doc_id: number;
  full_text: string;
  metadata: EdrsrDocMetadata;
}

export interface EdrsrDocMetadata {
  court_code?: number;
  judge?: string;
  cause_num?: string;
  justice_kind?: number;
  adjudication_date?: string;
  judgment_code?: number;
  category_code?: number;
}

export interface EdrsrSearchResult {
  id: string;
  score: number;
  text: string;
  doc_id: number;
  chunk_index: number;
  metadata: EdrsrDocMetadata;
}

export interface EdrsrSearchFilters {
  court_code?: number;
  // Multi-court constraint (match-any on the court_code payload index). Used to push an
  // instance/court_level filter onto the vector leg: instance_code is NOT in the Qdrant payload,
  // but court_code is — so an instance filter is translated to its set of court_codes. Without
  // this the vector leg can't honour a court/instance filter and every vector candidate is
  // dropped by the post-fusion instance re-check, collapsing instance-filtered searches.
  court_codes?: number[];
  justice_kind?: number;
  date_from?: string;
  date_to?: string;
  judge?: string;
}

export interface EdrsrVectorizationStats {
  total_points: number;
  collection_exists: boolean;
}

export type EmbeddingUsageCallback = (tokens: number, model: string, task: string) => void;

// ── Chunking ─────────────────────────────────────────────────────────────────

function chunkText(text: string, maxChars = MAX_CHUNK_CHARS, overlapWords = CHUNK_OVERLAP_WORDS): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);

    // Try to break at sentence boundary
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf('.', end);
      if (lastPeriod > start + maxChars * 0.5) end = lastPeriod + 1;
    }

    chunks.push(text.slice(start, end));

    if (end >= text.length) break;

    // Overlap: go back by overlapWords words
    const words = text.slice(start, end).split(/\s+/);
    const overlapText = words.slice(-overlapWords).join(' ');
    const newStart = end - overlapText.length;

    // Safety: always advance by at least half the chunk size to prevent infinite loops
    // (can happen when text has ≤50 very long words, making overlap ≥ chunk size)
    start = Math.max(newStart, start + Math.floor(maxChars / 2));

    if (start >= text.length - 100) break; // Don't create tiny last chunk
  }

  return chunks;
}

// ── Service ──────────────────────────────────────────────────────────────────

export class EdsrVectorizerService {
  private embeddingClient: BgeM3Client;
  private qdrant: QdrantClient;
  private initialized = false;
  private usageCallback?: EmbeddingUsageCallback;
  // Shared across all callers (singleton service) → global cap on concurrent searches.
  private readonly searchSemaphore = new AsyncSemaphore(QDRANT_SEARCH_CONCURRENCY);
  private concurrency: number;

  constructor(concurrency: number = DEFAULT_CONCURRENCY) {
    const bgeUrl = process.env.BGE_M3_URL;
    if (!bgeUrl) {
      throw new Error('BGE_M3_URL is required for EdsrVectorizerService');
    }
    this.embeddingClient = new BgeM3Client(bgeUrl);

    const qdrantUrl = process.env.QDRANT_EDRSR_URL || process.env.QDRANT_URL || 'http://localhost:6333';
    const qdrantApiKey = process.env.QDRANT_EDRSR_API_KEY || process.env.QDRANT_API_KEY;
    // Cap request duration so a rare disk-bound stall on the large on-disk
    // `edrsr_serving` collection fails fast and the caller can degrade to FTS,
    // instead of hanging until the upstream 60s timeout and surfacing a 500.
    const qdrantTimeoutMs = Number(process.env.QDRANT_EDRSR_TIMEOUT_MS || 12000);
    this.qdrant = new QdrantClient({
      url: qdrantUrl,
      timeout: qdrantTimeoutMs,
      ...(qdrantApiKey && { apiKey: qdrantApiKey }),
    });

    this.concurrency = concurrency;
    logger.info('[EdsrVectorizer] initialized', { collection: COLLECTION_NAME, qdrantUrl });
  }

  setUsageCallback(cb: EmbeddingUsageCallback | undefined): void {
    this.usageCallback = cb;
  }

  // ── Initialization ───────────────────────────────────────────────────────

  /**
   * Lazy initialization: ensure the EDRSR collection is usable before first read.
   *
   * On a read-only serving node (e.g. `edrsr_serving`, 296M points) the collection
   * and its payload indexes already exist. The old implementation, on every init,
   * (a) called `getCollection()` — which scans `points_count` over the whole
   * collection and takes tens of seconds on a disk-bound serving node, and
   * (b) re-issued `createPayloadIndex` for all filterable fields. Under load this
   * became a self-sustaining disk storm: the heavy index (re)builds saturated the
   * serving node's IOPS → `getCollection()` timed out → `initialized` was never set
   * → the next search re-ran the whole handshake and re-queued more index builds.
   * Searches degraded to FTS-only (`vector_available:false`) the entire time.
   *
   * Fix: keep the read path cheap. Existence is checked with `getCollections()`
   * (a name listing, not a points scan). If the collection exists we trust it and
   * mark init complete — collection/index creation is the vectorization pipeline's
   * job, not the search path's. The heavy create+verify path runs ONLY when the
   * collection is genuinely missing. `QDRANT_EDRSR_SKIP_INIT=true` skips even the
   * existence probe for serving nodes where the collection is known-good.
   */
  private async ensureCollection(): Promise<void> {
    if (this.initialized) return;

    // Serving-node fast path: collection + indexes are known to exist, so skip
    // every network round-trip and never touch index creation.
    if (process.env.QDRANT_EDRSR_SKIP_INIT === 'true') {
      this.initialized = true;
      logger.info('[EdsrVectorizer] init skipped (QDRANT_EDRSR_SKIP_INIT) — assuming collection + indexes exist', { collection: COLLECTION_NAME });
      return;
    }

    try {
      // Cheap existence check — lists collection names, does NOT scan points.
      const collections = await this.qdrant.getCollections();
      const exists = collections.collections.some((c) => c.name === COLLECTION_NAME);

      if (exists) {
        // Already present — trust it. Do NOT call getCollection() (heavy
        // points_count scan) or re-create payload indexes on every init; that
        // work belongs to the vectorization pipeline, not the read path, and
        // re-issuing it here is what saturated the serving node's disk.
        this.initialized = true;
        logger.info(`[EdsrVectorizer] Collection ${COLLECTION_NAME} present — init complete (lazy)`);
        return;
      }

      // Collection genuinely missing — create it and its indexes once.
      await this._createCollection();
      await this._ensurePayloadIndexes();
      this.initialized = true;
    } catch (error) {
      logger.error('[EdsrVectorizer] Failed to initialize collection:', error);
      throw error;
    }
  }

  private async _createCollection(): Promise<void> {
    await this.qdrant.createCollection(COLLECTION_NAME, {
      vectors: { size: EMBEDDING_DIM, distance: 'Cosine' },
      on_disk_payload: true,
    });
    logger.info(`[EdsrVectorizer] Created Qdrant collection: ${COLLECTION_NAME}`);
  }

  /**
   * Declare every payload field `semanticSearch` filters on.
   *
   * Every field listed here MUST have an index, and the index type must match how
   * the field is queried — an unindexed (or wrongly-typed) filter field does not
   * fail loudly, it makes Qdrant fall back to scanning the payload store. Measured
   * on the 189M-point serving collection on 2026-08-11, with `adjudication_date`
   * and `judge` missing: an indexed `court_code` filter answered in 4.5 ms, an
   * `adjudication_date` range took 20-60 s, and a `judge` match hit Qdrant's 60 s
   * internal timeout and returned nothing at all. The backend's own
   * QDRANT_EDRSR_TIMEOUT_MS is 20 s, so those searches simply failed in prod.
   *
   * `adjudication_date` is `datetime`, not `keyword`: it is queried with `range`,
   * and a keyword index cannot serve a range filter at all. Verified that Qdrant
   * parses both the stored form ("2012-12-27 22:00:00+00") and the "YYYY-MM-DD"
   * bounds the tools pass.
   *
   * `judge` is `text` with the word tokenizer, because the tools advertise partial
   * names — see the filter construction in `semanticSearch` for why an exact-match
   * index is the wrong shape here.
   *
   * Schemas are sent as given. The integer fields stay bare strings on purpose: the
   * object form makes Qdrant apply only the sub-indexes named in it, so spelling out
   * `{ lookup: true }` without `range: true` would quietly cost integer range
   * filters. The string form keeps Qdrant's defaults, which enable both.
   */
  private async _ensurePayloadIndexes(): Promise<void> {
    const indexes: Array<{ field: string; schema: any }> = [
      { field: 'edrsr_doc_id', schema: 'integer' },
      { field: 'court_code', schema: 'integer' },
      { field: 'justice_kind', schema: 'integer' },
      { field: 'instance_code', schema: 'integer' },
      { field: 'judgment_code', schema: 'integer' },
      { field: 'chunk_index', schema: 'integer' },
      { field: 'adjudication_date', schema: { type: 'datetime' } },
      {
        field: 'judge',
        schema: { type: 'text', tokenizer: 'word', lowercase: true, min_token_len: 2, max_token_len: 30 },
      },
    ];

    for (const idx of indexes) {
      try {
        await this.qdrant.createPayloadIndex(COLLECTION_NAME, {
          field_name: idx.field,
          field_schema: idx.schema,
          wait: false,
        });
      } catch {
        // Index may already exist — non-critical
      }
    }
  }

  // ── Core: ensureVectorized ─────────────────────────────────────────────

  /**
   * Check which doc_ids already have vectors in Qdrant, vectorize missing ones.
   * Returns a map of doc_id → array of Qdrant point IDs.
   */
  async ensureVectorized(docIds: number[], dbPool: any): Promise<Map<number, string[]>> {
    if (docIds.length === 0) return new Map();

    await this.ensureCollection();

    const result = new Map<number, string[]>();

    // 1. Check Qdrant for existing vectors
    const existingMap = await this._findExistingVectors(docIds);

    // Separate found vs missing
    const missingDocIds: number[] = [];
    for (const docId of docIds) {
      if (existingMap.has(docId)) {
        result.set(docId, existingMap.get(docId)!);
      } else {
        missingDocIds.push(docId);
      }
    }

    if (missingDocIds.length === 0) {
      logger.info(`[EdsrVectorizer] All ${docIds.length} doc_ids already vectorized`);
      return result;
    }

    logger.info(`[EdsrVectorizer] ${existingMap.size}/${docIds.length} already vectorized, ${missingDocIds.length} to process`);

    // 2. Fetch fulltext from PG for missing doc_ids
    const docs = await this._fetchDocuments(missingDocIds, dbPool);

    if (docs.length === 0) {
      logger.warn(`[EdsrVectorizer] No fulltext found for ${missingDocIds.length} doc_ids`);
      return result;
    }

    // 3. Vectorize in parallel batches
    const semaphore = new Semaphore(this.concurrency);
    const batchSize = this.concurrency;
    const vectorizePromises: Promise<void>[] = [];

    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = docs.slice(i, i + batchSize);
      const promise = (async () => {
        const release = await semaphore.acquire();
        try {
          const pointIds = await this._vectorizeBatch(batch);
          // Collect results
          pointIds.forEach((ids, docId) => {
            result.set(docId, ids);
          });
        } finally {
          release();
        }
      })();
      vectorizePromises.push(promise);
    }

    await Promise.all(vectorizePromises);

    logger.info(`[EdsrVectorizer] Vectorized ${docs.length} documents (${result.size} total with cache)`);
    return result;
  }

  // ── Core: vectorizeDocuments ───────────────────────────────────────────

  /**
   * Chunk, embed, and store documents in Qdrant.
   * For bulk ingestion — caller provides full_text and metadata.
   */
  async vectorizeDocuments(docs: EdrsrDocument[]): Promise<void> {
    if (docs.length === 0) return;

    await this.ensureCollection();

    const semaphore = new Semaphore(this.concurrency);
    const batchSize = this.concurrency;
    const promises: Promise<void>[] = [];

    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = docs.slice(i, i + batchSize);
      const promise = (async () => {
        const release = await semaphore.acquire();
        try {
          await this._vectorizeBatch(batch);
        } finally {
          release();
        }
      })();
      promises.push(promise);
    }

    await Promise.all(promises);

    logger.info(`[EdsrVectorizer] vectorizeDocuments complete: ${docs.length} documents`);
  }

  // ── Core: semanticSearch ───────────────────────────────────────────────

  /**
   * Embed query and search edrsr_decisions collection with metadata filters.
   */
  async semanticSearch(
    query: string,
    filters?: EdrsrSearchFilters,
    limit: number = 10,
    scoreThreshold?: number
  ): Promise<EdrsrSearchResult[]> {
    await this.ensureCollection();

    // Optional relevance floor. BGE-M3 cosine for genuinely on-topic legal
    // chunks sits well above the noise band; the low-score tail is dominated by
    // incidental mentions (e.g. a courier named in passing rather than a party
    // to the case). Dropping sub-threshold hits in Qdrant trims that noise
    // cheaply — before the costlier LLM result-filter ever sees it. Off by
    // default (env-driven); calibrate per scoring mode, since rescore:false
    // returns quantization-derived scores on a slightly different scale.
    const envThreshold = process.env.QDRANT_EDRSR_SCORE_THRESHOLD;
    const threshold = scoreThreshold ??
      (envThreshold !== undefined && envThreshold !== '' ? Number(envThreshold) : undefined);

    // Embed query
    const result = await this.embeddingClient.generateEmbeddingsBatchWithUsage([query]);
    this.usageCallback?.(result.totalTokens, EMBEDDING_MODEL, 'edrsr_semantic_search');
    const queryVector = result.embeddings[0];

    // Build Qdrant filter
    const must: any[] = [];

    // court_code / justice_kind payload indices are integers. Tool-call args (and HTTP
    // JSON) often arrive as strings ("4"); a string `value` is treated by Qdrant as a
    // keyword and silently matches nothing, so the vector leg returns 0 candidates even
    // though the code exists. Coerce to Number so the integer index actually matches.
    if (filters?.court_code) {
      must.push({ key: 'court_code', match: { value: Number(filters.court_code) } });
    } else if (filters?.court_codes?.length) {
      // match-any over the court_code integer index (e.g. all cassation courts for an
      // instance/court_level filter). Single court_code wins if both are somehow set.
      must.push({ key: 'court_code', match: { any: filters.court_codes.map(Number) } });
    }

    if (filters?.justice_kind) {
      must.push({ key: 'justice_kind', match: { value: Number(filters.justice_kind) } });
    }

    // Full-text match against the `judge` text index (word tokenizer, lowercased).
    // The index was missing entirely until 2026-08-11, so this filter degenerated into
    // a payload scan and hit Qdrant's 60 s internal timeout, returning zero hits.
    //
    // Text match — not `match: { value }` — is deliberate: every tool that exposes this
    // filter advertises partial names ("ПІБ судді або частина ПІБ" in
    // edrsr-unified-search-tool / edrsr-search-tools / edrsr-hybrid-tools), so callers
    // legitimately pass a surname alone. An exact-match index would have silently
    // returned nothing for those and dropped the vector leg out of hybrid search, while
    // the FTS leg (LOWER(d.judge) LIKE %v%) kept matching.
    //
    // Resolving a fragment to canonical names via Postgres was considered and rejected:
    // `judges_current` holds only sitting judges (5 952 rows) and is missing judges from
    // older decisions, so historical cases would lose the vector leg instead.
    //
    // Residual gap: the word tokenizer matches whole tokens, so "Писана" and "Таміла"
    // both hit but a mid-word prefix ("Писан") does not, where the FTS leg would. A
    // `prefix` tokenizer closes that at an index size that expands with every token.
    if (filters?.judge) {
      must.push({ key: 'judge', match: { text: filters.judge.trim() } });
    }

    if (filters?.date_from || filters?.date_to) {
      const range: any = {};
      if (filters?.date_from) range.gte = filters.date_from;
      if (filters?.date_to) range.lte = filters.date_to;
      must.push({ key: 'adjudication_date', range });
    }

    const qdrantFilter = must.length > 0 ? { must } : undefined;

    try {
      // Bound concurrent Qdrant searches — see QDRANT_SEARCH_CONCURRENCY (LEXAI-1758).
      const searchResult = await this.searchSemaphore.run(() => this.qdrant.search(COLLECTION_NAME, {
        vector: queryVector,
        limit,
        filter: qdrantFilter,
        with_payload: true,
        ...(threshold !== undefined && Number.isFinite(threshold) ? { score_threshold: threshold } : {}),
        // The collection keeps full f32 vectors on disk with binary quantization in
        // RAM, so scoring can run either on the 1-bit codes alone (rescore off) or
        // on the originals (rescore on). Prod sets QDRANT_EDRSR_RESCORE=true.
        //
        // This used to default off, on the grounds that rescore "stalls past the
        // request timeout under concurrency". Re-measured on the current serving
        // node (2026-08-11, 30 distinct queries at concurrency 6, LEXAI-1922) that
        // is not true and the cost of leaving it off is severe:
        //
        //             p50    p95    p99    max      overlap@10   top-1 agreement
        //   off      13ms   30ms   68ms   72ms        1.50/10           1/30
        //   on       14ms   38ms   49ms   62ms        8.57/10          25/30
        //
        // (agreement measured against full-precision ranking at the same hnsw_ef,
        // so only rescore differs; f32 originals are ~0% resident and stay that
        // way — rescore reads ~20 vectors per segment, peaking at ~1.1k IOPS.)
        //
        // Scoring on 1-bit codes alone got the top result right in 1 query out of
        // 30. Rescore costs no measurable latency here — the worst request was
        // 62 ms against QDRANT_EDRSR_TIMEOUT_MS=20000. Turn it off only with a
        // fresh measurement on the node you are actually serving from.
        params: {
          hnsw_ef: Number(process.env.QDRANT_EDRSR_HNSW_EF || 128),
          quantization:
            process.env.QDRANT_EDRSR_RESCORE === 'true'
              ? { rescore: true, oversampling: Number(process.env.QDRANT_EDRSR_OVERSAMPLING || 2.0) }
              : { rescore: false },
        },
      }));

      return searchResult.map((r) => ({
        id: r.id as string,
        score: r.score,
        text: (r.payload?.text as string) || '',
        doc_id: (r.payload?.edrsr_doc_id as number) || 0,
        chunk_index: (r.payload?.chunk_index as number) || 0,
        metadata: {
          court_code: r.payload?.court_code as number | undefined,
          judge: r.payload?.judge as string | undefined,
          cause_num: r.payload?.cause_num as string | undefined,
          justice_kind: r.payload?.justice_kind as number | undefined,
          adjudication_date: r.payload?.adjudication_date as string | undefined,
          judgment_code: r.payload?.judgment_code as number | undefined,
          category_code: r.payload?.category_code as number | undefined,
        },
      }));
    } catch (error) {
      logger.error('[EdsrVectorizer] semanticSearch failed:', error);
      throw error;
    }
  }

  // ── Best chunk per document (evidence backfill) ────────────────────────

  /**
   * Return the single most query-relevant chunk for each given doc_id.
   *
   * Used to backfill an evidence snippet for hybrid hits that came ONLY from the FTS
   * leg (and therefore have no qdrant_best_chunk_text). Without this, the LLM relevance
   * filter judges such hits on an uninformative ts_headline — which, when the matched
   * terms are scattered, collapses to the decision's boilerplate header (court, case
   * number, judges) and carries zero topical signal, so genuinely on-topic FTS matches
   * get wrongly dropped. Embeds the query once, then issues one top-1 vector search per
   * doc_id constrained by the edrsr_doc_id payload index, so every doc gets its own best
   * chunk regardless of how it ranks globally. Failures per doc are swallowed (best-effort).
   */
  async bestChunkForDocs(
    query: string,
    docIds: number[],
  ): Promise<Map<number, { text: string; chunk_index: number; score: number }>> {
    const out = new Map<number, { text: string; chunk_index: number; score: number }>();
    const uniqueIds = Array.from(new Set(docIds.filter((id) => Number.isFinite(id) && id > 0)));
    if (!query?.trim() || uniqueIds.length === 0) return out;

    await this.ensureCollection();

    const result = await this.embeddingClient.generateEmbeddingsBatchWithUsage([query]);
    this.usageCallback?.(result.totalTokens, EMBEDDING_MODEL, 'edrsr_best_chunk');
    const queryVector = result.embeddings[0];
    if (!queryVector) return out;

    // Mirror semanticSearch's scoring params so the backfilled chunk is selected on the
    // same basis as the vector leg's chunks (in-RAM quantized scoring by default).
    const searchParams = {
      hnsw_ef: Number(process.env.QDRANT_EDRSR_HNSW_EF || 128),
      quantization:
        process.env.QDRANT_EDRSR_RESCORE === 'true'
          ? { rescore: true, oversampling: Number(process.env.QDRANT_EDRSR_OVERSAMPLING || 2.0) }
          : { rescore: false },
    };

    await Promise.all(uniqueIds.map((docId) => this.searchSemaphore.run(async () => {
      try {
        const hits = await this.qdrant.search(COLLECTION_NAME, {
          vector: queryVector,
          limit: 1,
          filter: { must: [{ key: 'edrsr_doc_id', match: { value: docId } }] },
          with_payload: true,
          params: searchParams,
        });
        const top = hits[0];
        const text = top?.payload?.text as string | undefined;
        if (top && text) {
          out.set(docId, {
            text,
            chunk_index: (top.payload?.chunk_index as number) || 0,
            score: top.score,
          });
        }
      } catch (err: any) {
        logger.warn('[EdsrVectorizer] bestChunkForDocs failed', { docId, error: err.message });
      }
    })));

    return out;
  }

  // ── Core: getVectorizationStats ────────────────────────────────────────

  /**
   * Return stats from the edrsr_decisions Qdrant collection.
   */
  async getVectorizationStats(): Promise<EdrsrVectorizationStats> {
    try {
      const collections = await this.qdrant.getCollections();
      const exists = collections.collections.some((c) => c.name === COLLECTION_NAME);

      if (!exists) {
        return { total_points: 0, collection_exists: false };
      }

      const info = await this.qdrant.getCollection(COLLECTION_NAME);
      return {
        total_points: info.points_count || 0,
        collection_exists: true,
      };
    } catch (error) {
      logger.error('[EdsrVectorizer] getVectorizationStats failed:', error);
      return { total_points: 0, collection_exists: false };
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /**
   * Scroll Qdrant for existing vectors matching the given doc_ids.
   * Returns map of doc_id → array of point IDs.
   */
  private async _findExistingVectors(docIds: number[]): Promise<Map<number, string[]>> {
    const existingMap = new Map<number, string[]>();

    // Query in batches to avoid huge filter clauses
    const SCROLL_BATCH = 100;
    for (let i = 0; i < docIds.length; i += SCROLL_BATCH) {
      const batchIds = docIds.slice(i, i + SCROLL_BATCH);

      try {
        const scrollResult = await this.qdrant.scroll(COLLECTION_NAME, {
          filter: {
            should: batchIds.map((id) => ({
              key: 'edrsr_doc_id',
              match: { value: id },
            })),
          },
          limit: batchIds.length * 20, // Up to 20 chunks per doc
          with_payload: { include: ['edrsr_doc_id'] },
          with_vector: false,
        });

        for (const point of scrollResult.points) {
          const docId = point.payload?.edrsr_doc_id as number;
          if (docId !== undefined) {
            if (!existingMap.has(docId)) {
              existingMap.set(docId, []);
            }
            existingMap.get(docId)!.push(point.id as string);
          }
        }
      } catch (error) {
        logger.warn('[EdsrVectorizer] Scroll check failed for batch, treating as missing', { error });
      }
    }

    return existingMap;
  }

  /**
   * Fetch fulltext and metadata from PG for given doc_ids.
   */
  private async _fetchDocuments(docIds: number[], dbPool: any): Promise<EdrsrDocument[]> {
    const docs: EdrsrDocument[] = [];

    // Query in batches of 500 to avoid parameter limit issues
    const PG_BATCH = 500;
    for (let i = 0; i < docIds.length; i += PG_BATCH) {
      const batchIds = docIds.slice(i, i + PG_BATCH);

      try {
        const result = await dbPool.query(
          `SELECT
            d.doc_id, d.cause_num, d.judge, d.court_code, d.justice_kind,
            d.judgment_code, d.category_code, d.adjudication_date,
            f.full_text
          FROM edrsr_documents d
          INNER JOIN edrsr_fulltext f ON f.doc_id = d.doc_id
          WHERE d.doc_id = ANY($1)
            AND f.full_text IS NOT NULL
            AND f.full_text != ''`,
          [batchIds]
        );

        for (const row of result.rows) {
          docs.push({
            doc_id: row.doc_id,
            full_text: row.full_text,
            metadata: {
              court_code: row.court_code,
              judge: row.judge,
              cause_num: row.cause_num,
              justice_kind: row.justice_kind,
              adjudication_date: row.adjudication_date
                ? (typeof row.adjudication_date === 'string'
                    ? row.adjudication_date
                    : row.adjudication_date.toISOString().split('T')[0])
                : undefined,
              judgment_code: row.judgment_code,
              category_code: row.category_code,
            },
          });
        }
      } catch (error) {
        logger.error('[EdsrVectorizer] Failed to fetch documents from PG', { error, batchSize: batchIds.length });
      }
    }

    return docs;
  }

  /**
   * Vectorize a batch of documents: chunk → embed → upsert to Qdrant.
   * Returns map of doc_id → array of Qdrant point IDs.
   */
  private async _vectorizeBatch(docs: EdrsrDocument[]): Promise<Map<number, string[]>> {
    const result = new Map<number, string[]>();

    // 1. Chunk all documents
    const allChunks: Array<{
      text: string;
      docId: number;
      chunkIndex: number;
      totalChunks: number;
      metadata: EdrsrDocMetadata;
    }> = [];

    for (const doc of docs) {
      const chunks = chunkText(doc.full_text);
      const pointIds: string[] = [];

      for (let i = 0; i < chunks.length; i++) {
        allChunks.push({
          text: chunks[i],
          docId: doc.doc_id,
          chunkIndex: i,
          totalChunks: chunks.length,
          metadata: doc.metadata,
        });
      }

      // Pre-initialize result entry (point IDs will be filled after embedding)
      result.set(doc.doc_id, pointIds);
    }

    if (allChunks.length === 0) return result;

    // 2. Embed in batches of EMBED_BATCH_SIZE
    const texts = allChunks.map((c) => c.text);
    let allEmbeddings: number[][] = [];
    let totalTokens = 0;

    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
      const batchResult: EmbeddingBatchResult = await this.embeddingClient.generateEmbeddingsBatchWithUsage(batch);
      allEmbeddings.push(...batchResult.embeddings);
      totalTokens += batchResult.totalTokens;
    }

    this.usageCallback?.(totalTokens, EMBEDDING_MODEL, 'edrsr_vectorize');

    // 3. Build Qdrant points
    const points = allChunks.map((chunk, idx) => {
      const pointId = uuidv4();

      // Add point ID to the doc's result array
      result.get(chunk.docId)!.push(pointId);

      return {
        id: pointId,
        vector: allEmbeddings[idx],
        payload: {
          edrsr_doc_id: chunk.docId,
          court_code: chunk.metadata.court_code ?? null,
          judge: chunk.metadata.judge ?? null,
          cause_num: chunk.metadata.cause_num ?? null,
          justice_kind: chunk.metadata.justice_kind ?? null,
          adjudication_date: chunk.metadata.adjudication_date ?? null,
          judgment_code: chunk.metadata.judgment_code ?? null,
          category_code: chunk.metadata.category_code ?? null,
          chunk_index: chunk.chunkIndex,
          total_chunks: chunk.totalChunks,
          text: chunk.text,
          embedding_model: EMBEDDING_MODEL,
        },
      };
    });

    // 4. Upsert to Qdrant in sub-batches with retry
    for (let i = 0; i < points.length; i += QDRANT_UPSERT_BATCH) {
      const batch = points.slice(i, i + QDRANT_UPSERT_BATCH);
      let retries = 3;

      while (retries > 0) {
        try {
          await this.qdrant.upsert(COLLECTION_NAME, {
            wait: true,
            points: batch,
          });
          break;
        } catch (err: any) {
          retries--;
          if (retries === 0) {
            logger.error('[EdsrVectorizer] Qdrant upsert failed after 3 retries', { error: err.message });
            throw err;
          }
          logger.warn(`[EdsrVectorizer] Qdrant upsert retry (${3 - retries}/3): ${err.message}`);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }

    logger.info(`[EdsrVectorizer] Batch complete: ${docs.length} docs, ${allChunks.length} chunks, ${totalTokens} tokens`);

    return result;
  }
}
