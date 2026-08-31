import { logger } from '../utils/logger.js';
import { DocumentService, type Document } from '../services/document-service.js';
import { SemanticSectionizer } from '../services/semantic-sectionizer.js';
import type { IEmbeddingPort, ICachePort } from '../domain/ports/index.js';
import { requestContext } from '../utils/openai-client.js';
import type { CostTracker } from '../services/cost-tracker.js';
import { SectionType } from '../types/index.js';
import { formatCourtDate } from '../api/tool-utils.js';
import {
  type ZakonOnlineDomainName,
  type DomainConfig,
  type SearchTarget,
  getDomainConfig,
} from '../types/zakononline-domains.js';

/**
 * Search parameters accepted by the adapter for backward-compatible method
 * signatures. The actual ZakonOnline API is disabled; these types are kept
 * so callers that build param objects don't need rewriting yet.
 */
interface ZOSearchParams {
  where?: any[];
  meta?: any;
  fulldata?: number;
  limit?: number;
  offset?: number;
  page?: number;
  target?: SearchTarget;
  mode?: string;
  orderBy?: {
    field: string;
    direction: 'asc' | 'desc';
  };
}

interface ZOSearchResponse {
  data: any[];
  total: number;
  meta?: any;
}

/**
 * EdsrLocalAdapter — local-only successor to ZOAdapter.
 *
 * Contains ONLY live code paths that operate against the local PostgreSQL /
 * Qdrant databases. All ZakonOnline HTTP methods return empty results
 * immediately (the API has been deprecated and disabled).
 *
 * This adapter preserves the same public method signatures as ZOAdapter so
 * that tool handlers and services can switch to it without code changes.
 */
export class EdsrLocalAdapter {
  private cache: ICachePort | null = null;
  private documentService: DocumentService | null = null;
  private sectionizer: SemanticSectionizer;
  private embeddingService: IEmbeddingPort | null = null;
  private domainConfig: DomainConfig;
  private costTracker: CostTracker | null = null;
  private externalApiMetrics: ((service: string, status: string, durationSec: number) => void) | null = null;

  // Background persistence queue (to avoid DB pool exhaustion on large responses)
  private persistQueue: any[] = [];
  private persistSeenIds: Set<string> = new Set();
  private persistTimer: NodeJS.Timeout | null = null;
  private persistInFlight: boolean = false;

  constructor(
    domainOrDocService?: ZakonOnlineDomainName | DocumentService,
    documentService?: DocumentService,
    embeddingService?: IEmbeddingPort,
    cache?: ICachePort,
    sectionizer?: SemanticSectionizer
  ) {
    // Backward compatibility: if first arg is DocumentService, use default domain
    let domain: ZakonOnlineDomainName = 'court_decisions';
    let docService: DocumentService | null = null;

    if (domainOrDocService instanceof DocumentService) {
      docService = domainOrDocService;
    } else if (typeof domainOrDocService === 'string') {
      domain = domainOrDocService;
      docService = documentService || null;
    } else {
      docService = documentService || null;
    }

    this.domainConfig = getDomainConfig(domain);
    this.documentService = docService;
    this.sectionizer = sectionizer || new SemanticSectionizer();
    this.embeddingService = embeddingService || null;
    this.cache = cache || null;

    logger.info(`EdsrLocalAdapter (${this.domainConfig.displayName}): using local EDRSR data`);
  }

  // ==================== TEXT EXTRACTION HELPERS ====================

  extractOutcome(text?: string | null): string | null {
    if (!text) return null;
    const t = text.toLowerCase();
    if (t.includes('частков')) return 'partial';
    if (t.includes('задовольн')) return 'allowed';
    if (t.includes('відмов')) return 'denied';
    if (t.includes('скасув') && (t.includes('направ') || t.includes('нов')))
      return 'remand';
    if (t.includes('скасув')) return 'cancelled';
    return null;
  }

  private extractDeviationFlag(text?: string | null): boolean | null {
    if (!text) return null;
    const t = text.toLowerCase();
    if (t.includes('відступ') && (t.includes('практик') || t.includes('висновк')))
      return true;
    return null;
  }

  extractLawArticlesSimple(text?: string | null): string[] {
    if (!text) return [];
    const matches = text.match(/ст\.\s*\d+/gi) || [];
    return Array.from(new Set(matches.map((m) => m.replace(/\s+/g, ' ').trim()))).slice(0, 50);
  }

  private normalizeDateToYMD(value: any): string | null {
    if (!value) return null;
    if (typeof value === 'string') {
      return value.length >= 10 ? value.slice(0, 10) : value;
    }
    try {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return null;
      return d.toISOString().slice(0, 10);
    } catch {
      return null;
    }
  }

  normalizeDocumentIdentity(doc: any): { zakononline_id: string; type: string } | null {
    const rawId = doc?.doc_id ?? doc?.id ?? doc?.zakononline_id;
    if (rawId == null || String(rawId).length === 0) return null;
    const domainName = this.domainConfig?.name || 'unknown';
    if (domainName === 'court_decisions') {
      const judgmentForm = doc?.judgment_form || doc?.form_name || doc?.judgment_form_name;
      const documentType = judgmentForm ? String(judgmentForm) : 'court_decision';
      return { zakononline_id: String(rawId), type: documentType };
    }
    return { zakononline_id: `${domainName}:${String(rawId)}`, type: domainName };
  }

  extractChamberFromText(text?: string | null): string | undefined {
    if (!text) return undefined;
    const t = text.toLowerCase();

    if (t.includes('велика палата') || t.includes('вп вс') || t.includes('великої палати верховного суду')) {
      return 'ВП ВС';
    }
    if (t.includes('кцс') || t.includes('касаційний цивільний суд')) return 'КЦС';
    if (t.includes('кгс') || t.includes('касаційний господарський суд')) return 'КГС';
    if (t.includes('кас') || t.includes('касаційний адміністративний суд')) return 'КАС';
    if (t.includes('ккс') || t.includes('касаційний кримінальний суд')) return 'ККС';

    return undefined;
  }

  // ==================== VECTOR STORE OPERATIONS ====================

  async indexSectionsToVectorStore(args: {
    docId: string;
    sections: Array<{ type: SectionType; text: string }>;
    metadata: {
      date: string;
      court?: string;
      chamber?: string;
      case_number?: string;
      dispute_category?: string;
      outcome?: string;
      deviation_flag?: boolean | null;
      law_articles?: string[];
    };
  }): Promise<void> {
    if (!this.embeddingService) return;

    const indexable = args.sections.filter(
      (s) => s.type === SectionType.DECISION || s.type === SectionType.COURT_REASONING
    );
    if (indexable.length === 0) return;

    for (const section of indexable) {
      const chunks = this.embeddingService.splitIntoChunks(section.text);
      if (chunks.length === 0) continue;

      const embeddings = await this.embeddingService.generateEmbeddingsBatch(chunks);
      const nowIso = new Date().toISOString();

      await Promise.all(chunks.map((chunk, i) =>
        this.embeddingService!.storeChunk({
          id: '',
          source: 'zakononline',
          doc_id: args.docId,
          section_type: section.type,
          text: chunk,
          embedding: embeddings[i],
          metadata: {
            date: args.metadata.date,
            court: args.metadata.court,
            chamber: args.metadata.chamber,
            case_number: args.metadata.case_number,
            dispute_category: args.metadata.dispute_category,
            outcome: args.metadata.outcome,
            deviation_flag: args.metadata.deviation_flag,
            law_articles: args.metadata.law_articles || [],
          },
          created_at: nowIso,
        })
      ));
    }
  }

  // ==================== DOCUMENT PERSISTENCE ====================

  private schedulePersistFlush(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flushPersistQueue().catch((e: any) => {
        logger.error('Persist queue flush failed:', e?.message);
      });
    }, 250);
  }

  enqueueDocumentsForPersistence(docs: any[]): void {
    if (!this.documentService || !Array.isArray(docs) || docs.length === 0) return;

    const MAX_QUEUE = 5000;

    for (const doc of docs) {
      const identity = this.normalizeDocumentIdentity(doc);
      if (!identity) continue;
      const idKey = identity.zakononline_id;
      if (this.persistSeenIds.has(idKey)) continue;
      this.persistSeenIds.add(idKey);
      this.persistQueue.push(doc);

      if (this.persistQueue.length > MAX_QUEUE) {
        this.persistQueue.shift();
      }
    }

    this.schedulePersistFlush();
  }

  private async flushPersistQueue(): Promise<void> {
    if (!this.documentService) return;
    if (this.persistInFlight) return;
    if (this.persistQueue.length === 0) return;

    this.persistInFlight = true;
    try {
      const envBatch = process.env.PERSIST_BATCH_SIZE;
      const BATCH_SIZE = envBatch && !Number.isNaN(Number(envBatch))
        ? Math.max(1, Math.floor(Number(envBatch)))
        : 50;

      const envConcurrency = process.env.PERSIST_CONCURRENCY;
      const PERSIST_CONCURRENCY = envConcurrency && !Number.isNaN(Number(envConcurrency))
        ? Math.max(1, Math.floor(Number(envConcurrency)))
        : 10;

      const allBatches: any[][] = [];
      while (this.persistQueue.length > 0) {
        const batch = this.persistQueue.splice(0, BATCH_SIZE);
        for (const doc of batch) {
          const identity = this.normalizeDocumentIdentity(doc);
          if (identity) this.persistSeenIds.delete(identity.zakononline_id);
        }
        allBatches.push(batch);
      }

      for (let i = 0; i < allBatches.length; i += PERSIST_CONCURRENCY) {
        const concurrentBatches = allBatches.slice(i, i + PERSIST_CONCURRENCY);
        await Promise.all(
          concurrentBatches.map(batch => this.saveDocumentsMetadataToDatabase(batch, batch.length))
        );
      }
    } finally {
      this.persistInFlight = false;
    }
  }

  /**
   * Save multiple documents to database WITHOUT loading full text.
   */
  async saveDocumentsMetadataToDatabase(docs: any[], maxDocs: number = 1000): Promise<void> {
    if (!this.documentService || !docs.length) {
      return;
    }

    const docsToProcess = docs.slice(0, maxDocs);
    const validDocs = docsToProcess.filter(doc => doc && (doc.doc_id != null || doc.id != null || doc.zakononline_id != null));
    if (validDocs.length === 0) {
      return;
    }

    try {
      const mapped = validDocs
        .map((doc) => {
          const identity = this.normalizeDocumentIdentity(doc);
          if (!identity) return null;

          const outcome = this.extractOutcome(doc.resolution || doc.full_text || null);
          const deviationFlag = this.extractDeviationFlag(doc.full_text || doc.resolution || null);
          const chamber = doc.chamber || this.extractChamberFromText(doc.full_text || doc.resolution || null);

          const title = doc.title || doc.name || doc.cause_num || doc.caption || undefined;
          const date = formatCourtDate(doc.adjudication_date || doc.date || doc.published_at);
          const caseNumber = doc.cause_num || doc.case_number || doc.metadata?.cause_num || undefined;

          return {
            zakononline_id: identity.zakononline_id,
            type: identity.type,
            title: title,
            date: date,
            case_number: caseNumber,
            court: (doc.court || doc.court_name)
              ? String(doc.court || doc.court_name)
              : (doc.court_code != null ? String(doc.court_code) : undefined),
            chamber: chamber,
            dispute_category: doc.category_code != null ? String(doc.category_code) : undefined,
            outcome: outcome ?? undefined,
            deviation_flag: deviationFlag,
            full_text: doc.full_text || null,
            full_text_html: doc.full_text_html || null,
            metadata: {
              ...((doc.metadata && typeof doc.metadata === 'object') ? doc.metadata : {}),
              _raw: {
                doc_id: doc.doc_id,
                id: doc.id,
                url: doc.url,
                snippet: doc.snippet,
              },
              cause_num: doc.cause_num,
              resolution: doc.resolution,
              judge: doc.judge,
              court_code: doc.court_code,
              category_code: doc.category_code,
              justice_kind: doc.justice_kind,
              judgment_form: doc.judgment_form || doc.form_name || doc.judgment_form_name || null,
            },
          } as Document;
        })
        .filter((d): d is Document => d != null);

      if (mapped.length === 0) {
        return;
      }

      await this.documentService.saveDocumentsBatch(mapped);
      logger.info('Saved documents metadata to database (no fulltext loading)', {
        count: mapped.length,
      });
    } catch (error: any) {
      logger.error('Failed to save documents metadata to database:', error?.message);
    }
  }

  /**
   * Save a single document to database
   */
  async saveDocumentToDatabase(doc: any): Promise<void> {
    if (!this.documentService || !doc.doc_id) {
      return;
    }

    try {
      const outcome = this.extractOutcome(doc.resolution || doc.full_text || null);
      const deviationFlag = this.extractDeviationFlag(doc.full_text || doc.resolution || null);
      const chamber = doc.chamber || this.extractChamberFromText(doc.full_text || doc.resolution || null);
      await this.documentService.saveDocument({
        zakononline_id: String(doc.doc_id),
        type: 'court_decision',
        title: doc.title || doc.cause_num || undefined,
        date: formatCourtDate(doc.adjudication_date || doc.date),
        case_number: doc.cause_num || undefined,
        court: (doc.court || doc.court_name) ? String(doc.court || doc.court_name) : (doc.court_code != null ? String(doc.court_code) : undefined),
        chamber: chamber,
        dispute_category: doc.category_code != null ? String(doc.category_code) : undefined,
        outcome: outcome ?? undefined,
        deviation_flag: deviationFlag,
        full_text: doc.full_text || null,
        full_text_html: doc.full_text_html || null,
        metadata: {
          cause_num: doc.cause_num,
          resolution: doc.resolution,
          judge: doc.judge,
          court_code: doc.court_code,
          category_code: doc.category_code,
          justice_kind: doc.justice_kind,
          url: doc.url,
          snippet: doc.snippet,
        },
      });
    } catch (error) {
      logger.error('Error saving document to database:', error);
    }
  }

  // ==================== DOMAIN / CONFIG ====================

  getDomain(): DomainConfig {
    return this.domainConfig;
  }

  getAvailableTargets(): SearchTarget[] {
    return this.domainConfig.availableTargets;
  }

  get disabled(): boolean {
    return true; // API is permanently disabled
  }

  // ==================== SETTERS ====================

  setCostTracker(tracker: CostTracker) {
    this.costTracker = tracker;
    logger.debug('Cost tracker attached to EdsrLocalAdapter');
  }

  setExternalApiMetrics(callback: (service: string, status: string, durationSec: number) => void) {
    this.externalApiMetrics = callback;
  }

  setCachePort(cache: ICachePort | null) {
    this.cache = cache;
  }

  // ==================== CACHE HELPERS ====================

  private async getCached(key: string): Promise<any | null> {
    if (!this.cache) return null;
    try {
      const cached = await this.cache.get(key);
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      logger.error('Redis get error:', error);
      return null;
    }
  }

  private async setCache(key: string, value: any, ttl: number = 3600) {
    if (!this.cache) return;
    try {
      await this.cache.set(key, JSON.stringify(value), ttl);
    } catch (error) {
      logger.error('Redis set error:', error);
    }
  }

  // ==================== RESPONSE NORMALIZATION ====================

  async normalizeResponse(response: any): Promise<any> {
    if (Array.isArray(response)) {
      return {
        data: response,
        total: response.length,
      };
    }

    if (response.data && Array.isArray(response.data)) {
      return {
        data: response.data,
        total: response.total || response.data.length,
        meta: response.meta,
      };
    }

    return {
      data: [response],
      total: 1,
    };
  }

  // ==================== COST TRACKING ====================

  private async trackSecondLayerUsage(
    operation: string,
    docId: string | number,
    cached: boolean
  ): Promise<void> {
    const context = requestContext.getStore();
    if (!context || !this.costTracker) {
      return;
    }

    try {
      await this.costTracker.recordSecondLayerCall({
        requestId: context.requestId,
        operation: operation,
        docId: docId,
        cached: cached,
      });

      if (!cached) {
        logger.debug('SecondLayer API call tracked', {
          requestId: context.requestId,
          operation,
          docId,
        });
      }
    } catch (error) {
      logger.error('Failed to track SecondLayer usage:', error);
    }
  }

  // ==================== DEPRECATED API STUBS ====================
  // These methods return empty results immediately.
  // They exist so callers don't need to add null checks yet.

  async searchCourtDecisions(_params: ZOSearchParams): Promise<ZOSearchResponse> {
    return { data: [], total: 0 };
  }

  async searchCourtPractice(_params: ZOSearchParams): Promise<ZOSearchResponse> {
    return { data: [], total: 0 };
  }

  async getDocumentByNumber(_docId: string | number): Promise<any | null> {
    return null;
  }

  async getDocumentById(_id: string | number): Promise<any | null> {
    return null;
  }

  async getDocumentFullText(_docId: string | number): Promise<{ html: string; text: string; case_number?: string } | null> {
    return null;
  }

  async getDocumentByCaseNumber(_caseNumber: string): Promise<any | null> {
    return null;
  }

  async saveDocumentsToDatabase(_docs: any[], _maxDocs?: number): Promise<void> {
    return;
  }

  async getSearchMetadata(_params: ZOSearchParams): Promise<any> {
    return { total: 0, facets: {} };
  }

  async getDictionary(
    _dictionaryName: string,
    _params?: { limit?: number; page?: number; nolimits?: number }
  ): Promise<any> {
    return { data: [], total: 0 };
  }

  async getCourtsDictionary(_params?: { limit?: number; page?: number }): Promise<any> {
    return { data: [], total: 0 };
  }

  async getInstancesDictionary(): Promise<any> {
    return { data: [], total: 0 };
  }

  async getJudgmentFormsDictionary(): Promise<any> {
    return { data: [], total: 0 };
  }

  async getJusticeKindsDictionary(): Promise<any> {
    return { data: [], total: 0 };
  }

  async getRegionsDictionary(): Promise<any> {
    return { data: [], total: 0 };
  }

  async getJudgesDictionary(_params?: { limit?: number; page?: number }): Promise<any> {
    return { data: [], total: 0 };
  }

  async getDocumentTypesDictionary(): Promise<any> {
    return { data: [], total: 0 };
  }

  async getAuthorsDictionary(): Promise<any> {
    return { data: [], total: 0 };
  }

  async getCategoriesDictionary(): Promise<any> {
    return { data: [], total: 0 };
  }

  async getTypesDictionary(): Promise<any> {
    return { data: [], total: 0 };
  }

  getAvailableDictionaries(): string[] {
    return Object.keys(this.domainConfig.endpoints.dictionaries);
  }
}
