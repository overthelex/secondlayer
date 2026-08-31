/**
 * EDRSR Hybrid Search — dense vectors (Qdrant/BGE-M3) + sparse FTS (tsvector) via RRF.
 *
 * 1 tool:
 * - edrsr_hybrid_search — паралельний виклик FTS + семантичного пошуку в Qdrant,
 *   мердж через Reciprocal Rank Fusion, дедуплікація по doc_id (Qdrant повертає
 *   per-chunk результати), збагачення метаданими суду.
 *
 * Чому RRF, не weighted sum score: cosine (Qdrant) і ts_rank_cd (PG FTS) мають
 * різні шкали. RRF оперує рангами, тому склейка коректна без калібрування.
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';
import type { EdsrFtsService, EdsrFtsFilters, EdsrFtsResult } from '../../services/edrsr-fts-service.js';
import type { EdsrVectorizerService, EdrsrSearchFilters, EdrsrSearchResult } from '../../services/edrsr-vectorizer-service.js';
import { formatCourtDate } from '../tool-utils.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_RRF_K = 60;
const DEFAULT_OVERSAMPLE = 3;
const MAX_OVERSAMPLE = 5;

interface FusedHit {
  doc_id: number;
  rrf_score: number;
  fts_rank: number | null;
  fts_position: number | null;
  fts_headline: string | null;
  qdrant_score: number | null;
  qdrant_position: number | null;
  qdrant_best_chunk_text: string | null;
  qdrant_best_chunk_index: number | null;
  metadata: {
    cause_num?: string;
    judge?: string;
    court_code?: number;
    justice_kind?: number;
    judgment_code?: number;
    category_code?: number;
    adjudication_date?: string;
  };
}

export class EdsrHybridTools extends BaseToolHandler {
  constructor(
    private db: any,
    private ftsService: EdsrFtsService,
    private vectorizer: EdsrVectorizerService
  ) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'edrsr_hybrid_search',
        annotations: { title: 'Гібридний пошук ЄДРСР', readOnlyHint: true, openWorldHint: true },
        description: `Гібридний пошук судових рішень ЄДРСР: семантика (Qdrant, ~118M векторів, BGE-M3 1024-dim)
+ лексика (PG tsvector FTS) з мерджем через Reciprocal Rank Fusion.

Коли використовувати:
- запит містить і семантику, і рідкісні токени (номери статей, прізвища, назви установ);
- потрібен максимальний recall без жертви precision;
- pure FTS пропускає перефразування, pure semantic — точні матчі кодексів.

Повертає топ-K документів з rrf_score та провенансом обох сторін (fts_rank, qdrant_score,
snippet з FTS, найкращий chunk з Qdrant). Dedup по doc_id (Qdrant повертає per-chunk).`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Пошуковий запит українською. Натуральна мова + точні токени одночасно (напр., "ст. 210-1 КУпАП ТЦК неналежне оповіщення")',
            },
            court_code: {
              type: 'number',
              description: 'Опційно: код суду для звуження пошуку (edrsr_courts.court_code)',
            },
            justice_kind: {
              type: 'number',
              description: 'Опційно: 1=Цивільне, 2=Кримінальне, 3=Господарське, 4=Адміністративне, 5=Адмінправопорушення',
            },
            judge: {
              type: 'string',
              description: 'Опційно: ПІБ судді або частина',
            },
            date_from: {
              type: 'string',
              description: 'Опційно: дата ухвалення ВІД (YYYY-MM-DD)',
            },
            date_to: {
              type: 'string',
              description: 'Опційно: дата ухвалення ДО (YYYY-MM-DD)',
            },
            limit: {
              type: 'number',
              default: 10,
              maximum: 50,
              description: 'Максимальна кількість фінальних результатів (1-50)',
            },
            oversample: {
              type: 'number',
              default: 3,
              maximum: 5,
              description: 'Скільки кандидатів брати з кожної сторони перед мерджем (limit × oversample). Більше — кращий recall, повільніше.',
            },
            rrf_k: {
              type: 'number',
              default: 60,
              description: 'Параметр RRF (стандарт 60). Менше — сильніше впливає топ-1, більше — плавніше.',
            },
          },
          required: ['query'],
        },
      },
    ];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    if (name !== 'edrsr_hybrid_search') return null;
    return await this.hybridSearch(args);
  }

  private async hybridSearch(args: any): Promise<ToolResult> {
    const query = (args.query || '').trim();
    if (!query) return this.wrapError('query є обовʼязковим параметром');

    const limit = Math.min(Math.max(Number(args.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const oversample = Math.min(Math.max(Number(args.oversample) || DEFAULT_OVERSAMPLE, 1), MAX_OVERSAMPLE);
    const rrfK = Math.max(Number(args.rrf_k) || DEFAULT_RRF_K, 1);
    const candidateLimit = limit * oversample;

    const ftsFilters: EdsrFtsFilters = {
      court_code: args.court_code,
      justice_kind: args.justice_kind,
      judge: args.judge,
      date_from: args.date_from,
      date_to: args.date_to,
    };

    const qdrantFilters: EdrsrSearchFilters = {
      court_code: args.court_code,
      justice_kind: args.justice_kind,
      judge: args.judge,
      date_from: args.date_from,
      date_to: args.date_to,
    };

    const ftsPromise = this.ftsService
      .searchFulltext(query, this.db, ftsFilters, candidateLimit, 0)
      .catch((err: any) => {
        logger.warn('[EdsrHybridTools] FTS leg failed, continuing with vector-only', { error: err.message });
        return null;
      });

    const vectorPromise = this.vectorizer
      .semanticSearch(query, qdrantFilters, candidateLimit)
      .catch((err: any) => {
        logger.warn('[EdsrHybridTools] Qdrant leg failed, continuing with FTS-only', { error: err.message });
        return null;
      });

    const [ftsResponse, vectorResults] = await Promise.all([ftsPromise, vectorPromise]);

    if (!ftsResponse && !vectorResults) {
      return this.wrapError('Обидва джерела пошуку недоступні');
    }

    const ftsResults: EdsrFtsResult[] = ftsResponse?.results || [];
    const vectorHits: EdrsrSearchResult[] = vectorResults || [];

    const fused = this.fuseRRF(ftsResults, vectorHits, rrfK);
    const top = fused.slice(0, limit);
    const enriched = await this.enrich(top);

    logger.info('[EdsrHybridTools] edrsr_hybrid_search', {
      query,
      fts_candidates: ftsResults.length,
      vector_candidates: vectorHits.length,
      fused_docs: fused.length,
      returned: enriched.length,
    });

    return this.wrapResponse({
      query,
      filters: {
        court_code: args.court_code,
        justice_kind: args.justice_kind,
        judge: args.judge,
        date_from: args.date_from,
        date_to: args.date_to,
      },
      rrf_k: rrfK,
      oversample,
      legs: {
        fts_available: ftsResponse !== null,
        vector_available: vectorResults !== null,
        fts_candidates: ftsResults.length,
        vector_candidates: vectorHits.length,
      },
      total_fused: fused.length,
      returned: enriched.length,
      results: enriched,
    });
  }

  private fuseRRF(
    ftsResults: EdsrFtsResult[],
    vectorHits: EdrsrSearchResult[],
    k: number
  ): FusedHit[] {
    const byDocId = new Map<number, FusedHit>();

    // FTS leg — 1 doc = 1 result.
    ftsResults.forEach((r, idx) => {
      if (!r.doc_id) return;
      const docId = Number(r.doc_id);
      const rank = idx + 1;
      const hit: FusedHit = {
        doc_id: docId,
        rrf_score: 1 / (k + rank),
        fts_rank: typeof r.rank === 'number' ? r.rank : Number(r.rank) || 0,
        fts_position: rank,
        fts_headline: r.headline || null,
        qdrant_score: null,
        qdrant_position: null,
        qdrant_best_chunk_text: null,
        qdrant_best_chunk_index: null,
        metadata: {
          cause_num: r.cause_num,
          judge: r.judge,
          court_code: r.court_code,
          justice_kind: r.justice_kind,
          judgment_code: r.judgment_code,
          adjudication_date: formatCourtDate(r.adjudication_date),
        },
      };
      byDocId.set(docId, hit);
    });

    // Qdrant leg — several chunks per doc. Keep best chunk per doc_id, rank by first occurrence.
    const seenVectorDocs = new Set<number>();
    let vectorRank = 0;
    for (const v of vectorHits) {
      if (!v.doc_id) continue;
      const docId = Number(v.doc_id);

      if (seenVectorDocs.has(docId)) {
        // Same doc, different chunk — bump score only if this chunk is stronger.
        const existing = byDocId.get(docId);
        if (existing && (existing.qdrant_score === null || v.score > existing.qdrant_score)) {
          existing.qdrant_score = v.score;
          existing.qdrant_best_chunk_text = v.text || existing.qdrant_best_chunk_text;
          existing.qdrant_best_chunk_index = v.chunk_index;
        }
        continue;
      }

      seenVectorDocs.add(docId);
      vectorRank += 1;
      const rrfContribution = 1 / (k + vectorRank);

      const existing = byDocId.get(docId);
      if (existing) {
        existing.rrf_score += rrfContribution;
        existing.qdrant_score = v.score;
        existing.qdrant_position = vectorRank;
        existing.qdrant_best_chunk_text = v.text || null;
        existing.qdrant_best_chunk_index = v.chunk_index;
        if (v.metadata) {
          existing.metadata.cause_num = existing.metadata.cause_num || v.metadata.cause_num;
          existing.metadata.judge = existing.metadata.judge || v.metadata.judge;
          existing.metadata.court_code = existing.metadata.court_code ?? v.metadata.court_code;
          existing.metadata.justice_kind = existing.metadata.justice_kind ?? v.metadata.justice_kind;
          existing.metadata.judgment_code = existing.metadata.judgment_code ?? v.metadata.judgment_code;
          existing.metadata.category_code = existing.metadata.category_code ?? v.metadata.category_code;
          existing.metadata.adjudication_date = existing.metadata.adjudication_date || v.metadata.adjudication_date;
        }
      } else {
        byDocId.set(docId, {
          doc_id: docId,
          rrf_score: rrfContribution,
          fts_rank: null,
          fts_position: null,
          fts_headline: null,
          qdrant_score: v.score,
          qdrant_position: vectorRank,
          qdrant_best_chunk_text: v.text || null,
          qdrant_best_chunk_index: v.chunk_index,
          metadata: {
            cause_num: v.metadata?.cause_num,
            judge: v.metadata?.judge,
            court_code: v.metadata?.court_code,
            justice_kind: v.metadata?.justice_kind,
            judgment_code: v.metadata?.judgment_code,
            category_code: v.metadata?.category_code,
            adjudication_date: formatCourtDate(v.metadata?.adjudication_date),
          },
        });
      }
    }

    return Array.from(byDocId.values()).sort((a, b) => b.rrf_score - a.rrf_score);
  }

  private async enrich(hits: FusedHit[]): Promise<any[]> {
    if (hits.length === 0) return [];

    // Backfill missing metadata from edrsr_documents.
    // EdsrFtsService returns only {doc_id, headline, rank} when no metadata filter
    // is present (it skips the JOIN for speed). Qdrant returns metadata in payload,
    // but falls over when its collection is still indexing. So we top up from DB
    // unconditionally — it's one indexed ANY($1) query, ~5-10ms for 10-20 docs.
    const docsNeedingMetadata = hits
      .filter((h) => !h.metadata.court_code && !h.metadata.cause_num)
      .map((h) => h.doc_id);
    if (docsNeedingMetadata.length > 0) {
      const docMetaMap = await this.fetchDocumentMetadata(docsNeedingMetadata);
      for (const h of hits) {
        const meta = docMetaMap.get(h.doc_id);
        if (!meta) continue;
        h.metadata.cause_num = h.metadata.cause_num || meta.cause_num;
        h.metadata.judge = h.metadata.judge || meta.judge;
        h.metadata.court_code = h.metadata.court_code ?? meta.court_code;
        h.metadata.justice_kind = h.metadata.justice_kind ?? meta.justice_kind;
        h.metadata.judgment_code = h.metadata.judgment_code ?? meta.judgment_code;
        h.metadata.category_code = h.metadata.category_code ?? meta.category_code;
        h.metadata.adjudication_date =
          h.metadata.adjudication_date || meta.adjudication_date;
      }
    }

    const courtCodes = new Set<number>();
    const justiceKinds = new Set<number>();
    const judgmentCodes = new Set<number>();
    for (const h of hits) {
      if (h.metadata.court_code) courtCodes.add(h.metadata.court_code);
      if (h.metadata.justice_kind) justiceKinds.add(h.metadata.justice_kind);
      if (h.metadata.judgment_code) judgmentCodes.add(h.metadata.judgment_code);
    }

    const [courtsMap, justiceMap, judgmentMap] = await Promise.all([
      this.batchLookup('edrsr_courts', 'court_code', Array.from(courtCodes)),
      this.batchLookup('edrsr_justice_kinds', 'justice_kind', Array.from(justiceKinds)),
      this.batchLookup('edrsr_judgment_forms', 'judgment_code', Array.from(judgmentCodes)),
    ]);

    return hits.map((h) => ({
      doc_id: h.doc_id,
      cause_num: h.metadata.cause_num || null,
      judge: h.metadata.judge || null,
      court_code: h.metadata.court_code ?? null,
      court_name: h.metadata.court_code ? courtsMap.get(h.metadata.court_code) || null : null,
      justice_kind: h.metadata.justice_kind ?? null,
      justice_kind_name: h.metadata.justice_kind ? justiceMap.get(h.metadata.justice_kind) || null : null,
      judgment_code: h.metadata.judgment_code ?? null,
      judgment_form: h.metadata.judgment_code ? judgmentMap.get(h.metadata.judgment_code) || null : null,
      category_code: h.metadata.category_code ?? null,
      adjudication_date: formatCourtDate(h.metadata.adjudication_date) || null,
      rrf_score: Number(h.rrf_score.toFixed(6)),
      fts_position: h.fts_position,
      fts_rank: h.fts_rank,
      fts_headline: h.fts_headline,
      qdrant_position: h.qdrant_position,
      qdrant_score: h.qdrant_score !== null ? Number(h.qdrant_score.toFixed(6)) : null,
      qdrant_best_chunk_index: h.qdrant_best_chunk_index,
      qdrant_best_chunk_text: h.qdrant_best_chunk_text,
      external_url: `https://reyestr.court.gov.ua/Review/${h.doc_id}`,
    }));
  }

  private async fetchDocumentMetadata(
    docIds: number[]
  ): Promise<Map<number, FusedHit['metadata']>> {
    const map = new Map<number, FusedHit['metadata']>();
    if (docIds.length === 0) return map;
    try {
      const result = await this.db.query(
        `SELECT doc_id, court_code, cause_num, judge, justice_kind, judgment_code,
                category_code, adjudication_date
         FROM edrsr_documents
         WHERE doc_id = ANY($1)`,
        [docIds]
      );
      for (const row of result.rows) {
        map.set(Number(row.doc_id), {
          cause_num: row.cause_num ?? undefined,
          judge: row.judge ?? undefined,
          court_code: row.court_code ?? undefined,
          justice_kind: row.justice_kind ?? undefined,
          judgment_code: row.judgment_code ?? undefined,
          category_code: row.category_code ?? undefined,
          adjudication_date: formatCourtDate(row.adjudication_date),
        });
      }
    } catch (err: any) {
      logger.warn('[EdsrHybridTools] fetchDocumentMetadata failed (continuing with partial metadata)', {
        error: err.message,
        doc_count: docIds.length,
      });
    }
    return map;
  }

  private static readonly ALLOWED_LOOKUP_TABLES: Record<string, Set<string>> = {
    edrsr_courts: new Set(['court_code']),
    edrsr_justice_kinds: new Set(['justice_kind']),
    edrsr_judgment_forms: new Set(['judgment_code']),
  };

  private async batchLookup(
    table: string,
    idColumn: string,
    ids: number[]
  ): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    if (ids.length === 0) return map;
    const allowed = EdsrHybridTools.ALLOWED_LOOKUP_TABLES[table];
    if (!allowed || !allowed.has(idColumn)) return map;
    try {
      const result = await this.db.query(
        `SELECT ${idColumn}, name FROM ${table} WHERE ${idColumn} = ANY($1)`,
        [ids]
      );
      for (const row of result.rows) {
        map.set(row[idColumn], row.name);
      }
    } catch {
      // non-critical
    }
    return map;
  }
}
