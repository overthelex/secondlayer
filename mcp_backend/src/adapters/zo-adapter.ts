import axios, { AxiosInstance } from 'axios';
import { createClient } from 'redis';
import { CourtDecisionHTMLParser } from '../utils/html-parser.js';
import { logger } from '../utils/logger.js';
import { DocumentService, type Document } from '../services/document-service.js';
import { SemanticSectionizer } from '../services/semantic-sectionizer.js';
import { EmbeddingService } from '../services/embedding-service.js';
import { requestContext } from '../utils/openai-client.js';
import type { CostTracker } from '../services/cost-tracker.js';
import { SectionType } from '../types/index.js';
import {
  type ZakonOnlineDomainName,
  type DomainConfig,
  type SearchTarget,
  type SearchMode,
  getDomainConfig,
  isValidTarget,
} from '../types/zakononline-domains.js';
import {
  ZakonOnlineValidationError,
  createZakonOnlineError,
} from './zakononline-errors.js';

interface ZOSearchParams {
  where?: any[];
  meta?: any;
  fulldata?: number;
  limit?: number;
  offset?: number;
  target?: SearchTarget;
  mode?: SearchMode;
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

export class ZOAdapter {
  private client: AxiosInstance;
  private redis: ReturnType<typeof createClient> | null = null;
  private documentService: DocumentService | null = null;
  private sectionizer: SemanticSectionizer;
  private embeddingService: EmbeddingService | null = null;
  private apiTokens: string[];
  private currentTokenIndex: number = 0;
  private nextTokenIndex: number = 0;
  private domainConfig: DomainConfig;
  private lastRequestTimeByTokenIndex: number[] = [];
  private minRequestInterval: number = 200; // Minimum 200ms between requests (5 req/sec max)
  private rateLimitDelay: number = 1000; // Delay when rate limited
  private apiConcurrencyLimit: number | null = null;
  private apiInFlight: number = 0;
  private apiWaitQueue: Array<() => void> = [];
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
    embeddingService?: EmbeddingService
  ) {
    // Backward compatibility: if first arg is DocumentService, use default domain
    let domain: ZakonOnlineDomainName = 'court_decisions';
    let docService: DocumentService | null = null;

    if (domainOrDocService instanceof DocumentService) {
      // Old signature: new ZOAdapter(documentService)
      docService = domainOrDocService;
    } else if (typeof domainOrDocService === 'string') {
      // New signature: new ZOAdapter('domain_name', documentService)
      domain = domainOrDocService;
      docService = documentService || null;
    } else {
      // No arguments
      docService = documentService || null;
    }

    this.domainConfig = getDomainConfig(domain);
    this.documentService = docService;
    this.sectionizer = new SemanticSectionizer();
    this.embeddingService = embeddingService || null;

    // Support primary and secondary tokens
    const primaryToken = process.env.ZAKONONLINE_API_TOKEN || '';
    const secondaryToken = process.env.ZAKONONLINE_API_TOKEN2 || '';
    this.apiTokens = [primaryToken, secondaryToken].filter(t => t.length > 0);

    if (this.apiTokens.length === 0) {
      throw new Error('No Zakononline API tokens configured');
    }

    // If we have multiple tokens, prefer starting with the second one (TOKEN2)
    // This allows using a different token when the first one has issues
    if (this.apiTokens.length > 1 && secondaryToken) {
      // Start with second token if available
      this.currentTokenIndex = 1;
      logger.info(`Using secondary Zakononline token for ${this.domainConfig.displayName}`);
    } else {
      this.currentTokenIndex = 0;
      logger.info(`Using primary Zakononline token for ${this.domainConfig.displayName}`);
    }

    // Initialize token round-robin starting point
    this.nextTokenIndex = this.currentTokenIndex;

    // Per-token rate limit state
    this.lastRequestTimeByTokenIndex = new Array(this.apiTokens.length).fill(0);

    // Allow overriding rate limit timings via env vars (keep current defaults)
    const minIntervalEnv = process.env.ZAKONONLINE_MIN_REQUEST_INTERVAL_MS;
    if (minIntervalEnv && !Number.isNaN(Number(minIntervalEnv))) {
      this.minRequestInterval = Math.max(0, Number(minIntervalEnv));
    }
    const rateLimitDelayEnv = process.env.ZAKONONLINE_RATE_LIMIT_DELAY_MS;
    if (rateLimitDelayEnv && !Number.isNaN(Number(rateLimitDelayEnv))) {
      this.rateLimitDelay = Math.max(0, Number(rateLimitDelayEnv));
    }

    const apiConcurrencyEnv = process.env.API_CONCURRENCY_LIMIT;
    if (apiConcurrencyEnv && !Number.isNaN(Number(apiConcurrencyEnv))) {
      const parsed = Math.floor(Number(apiConcurrencyEnv));
      this.apiConcurrencyLimit = parsed > 0 ? parsed : null;
    }

    this.client = axios.create({
      baseURL: this.domainConfig.baseURL,
      timeout: 120000, // Increased to 120s for date-filtered queries
      headers: {
        'X-App-Token': this.getCurrentToken(),
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    });

    this.initializeRedis();

    logger.info(`ZOAdapter initialized for domain: ${this.domainConfig.displayName}`, {
      baseURL: this.domainConfig.baseURL,
      availableTargets: this.domainConfig.availableTargets,
    });
  }

  private extractOutcome(text?: string | null): string | null {
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

  private extractLawArticlesSimple(text?: string | null): string[] {
    if (!text) return [];
    const matches = text.match(/ст\.\s*\d+/gi) || [];
    return Array.from(new Set(matches.map((m) => m.replace(/\s+/g, ' ').trim()))).slice(0, 50);
  }

  private normalizeDateToYMD(value: any): string | null {
    if (!value) return null;
    if (typeof value === 'string') {
      // Handle ISO or YYYY-MM-DD
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

  private normalizeDocumentIdentity(doc: any): { zakononline_id: string; type: string } | null {
    // Court decisions have numeric doc_id. For other domains, prefix with domain to avoid collisions.
    const rawId = doc?.doc_id ?? doc?.id ?? doc?.zakononline_id;
    if (rawId == null || String(rawId).length === 0) return null;
    const domainName = this.domainConfig?.name || 'unknown';
    if (domainName === 'court_decisions') {
      // Extract judgment form (Постанова, Ухвала, Рішення, etc.) from API response
      // API provides this in judgment_form, form_name, or judgment_form_name fields
      const judgmentForm = doc?.judgment_form || doc?.form_name || doc?.judgment_form_name;
      const documentType = judgmentForm ? String(judgmentForm) : 'court_decision';
      return { zakononline_id: String(rawId), type: documentType };
    }
    return { zakononline_id: `${domainName}:${String(rawId)}`, type: domainName };
  }

  private schedulePersistFlush(): void {
    if (this.persistTimer) return;
    // Small debounce to coalesce multiple fetches into fewer DB writes
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flushPersistQueue().catch((e: any) => {
        logger.error('Persist queue flush failed:', e?.message);
      });
    }, 250);
  }

  private enqueueDocumentsForPersistence(docs: any[]): void {
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
        // Drop oldest to protect memory; dedup set will be cleared on flush
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

      // Drain in batches — up to 10 concurrent PG inserts
      const envConcurrency = process.env.PERSIST_CONCURRENCY;
      const PERSIST_CONCURRENCY = envConcurrency && !Number.isNaN(Number(envConcurrency))
        ? Math.max(1, Math.floor(Number(envConcurrency)))
        : 10;

      // Split queue into batches
      const allBatches: any[][] = [];
      while (this.persistQueue.length > 0) {
        const batch = this.persistQueue.splice(0, BATCH_SIZE);
        for (const doc of batch) {
          const identity = this.normalizeDocumentIdentity(doc);
          if (identity) this.persistSeenIds.delete(identity.zakononline_id);
        }
        allBatches.push(batch);
      }

      // Process batches with concurrency
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
   *
   * Use this when the caller already has the document payload (possibly including full_text)
   * and wants to persist it without triggering additional network calls.
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

          // Court decision-specific enrichments (safe fallbacks for other domains)
          const outcome = this.extractOutcome(doc.resolution || doc.full_text || null);
          const deviationFlag = this.extractDeviationFlag(doc.full_text || doc.resolution || null);
          const chamber = doc.chamber || this.extractChamberFromText(doc.full_text || doc.resolution || null);

          const title = doc.title || doc.name || doc.cause_num || doc.caption || undefined;
          const date = doc.adjudication_date || doc.date || doc.published_at || undefined;
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
              // Keep raw fields for future re-processing/indexing
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

  private extractChamberFromText(text?: string | null): string | undefined {
    if (!text) return undefined;
    const t = text.toLowerCase();

    // Priority: explicit Grand Chamber
    if (t.includes('велика палата') || t.includes('вп вс') || t.includes('великої палати верховного суду')) {
      return 'ВП ВС';
    }

    // Cassation courts (common Ukrainian abbreviations)
    if (t.includes('кцс') || t.includes('касаційний цивільний суд')) return 'КЦС';
    if (t.includes('кгс') || t.includes('касаційний господарський суд')) return 'КГС';
    if (t.includes('кас') || t.includes('касаційний адміністративний суд')) return 'КАС';
    if (t.includes('ккс') || t.includes('касаційний кримінальний суд')) return 'ККС';

    return undefined;
  }

  private async indexSectionsToVectorStore(args: {
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

      for (let i = 0; i < chunks.length; i++) {
        await this.embeddingService.storeChunk({
          id: '',
          source: 'zakononline',
          doc_id: args.docId,
          section_type: section.type,
          text: chunks[i],
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
        });
      }
    }
  }

  /**
   * Get the current domain configuration
   */
  getDomain(): DomainConfig {
    return this.domainConfig;
  }

  /**
   * Get available search targets for current domain
   */
  getAvailableTargets(): SearchTarget[] {
    return this.domainConfig.availableTargets;
  }

  private getCurrentToken(): string {
    return this.apiTokens[this.currentTokenIndex];
  }

  private getNextTokenIndex(): number {
    if (this.apiTokens.length <= 1) {
      return 0;
    }
    const idx = this.nextTokenIndex;
    this.nextTokenIndex = (this.nextTokenIndex + 1) % this.apiTokens.length;
    return idx;
  }

  private getTokenByIndex(index: number): string {
    return this.apiTokens[index] || this.apiTokens[0];
  }

  setCostTracker(tracker: CostTracker) {
    this.costTracker = tracker;
    logger.debug('Cost tracker attached to ZOAdapter');
  }

  setExternalApiMetrics(callback: (service: string, status: string, durationSec: number) => void) {
    this.externalApiMetrics = callback;
  }

  private async initializeRedis() {
    try {
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      this.redis = createClient({ url: redisUrl });
      await this.redis.connect();
      logger.info('Redis connected');
    } catch (error) {
      logger.warn('Redis connection failed, continuing without cache:', error);
      this.redis = null;
    }
  }

  private async getCached(key: string): Promise<any | null> {
    if (!this.redis) return null;
    try {
      const cached = await this.redis.get(key);
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      logger.error('Redis get error:', error);
      return null;
    }
  }

  private async setCache(key: string, value: any, ttl: number = 3600) {
    if (!this.redis) return;
    try {
      await this.redis.setEx(key, ttl, JSON.stringify(value));
    } catch (error) {
      logger.error('Redis set error:', error);
    }
  }

  private generateCacheKey(endpoint: string, params: any): string {
    return `zo:${endpoint}:${JSON.stringify(params)}`;
  }

  /**
   * Rate limiting: ensure minimum interval between requests to respect API limits
   */
  private async waitForRateLimit(tokenIndex: number): Promise<void> {
    const now = Date.now();
    const last = this.lastRequestTimeByTokenIndex[tokenIndex] || 0;
    const timeSinceLastRequest = now - last;

    if (timeSinceLastRequest < this.minRequestInterval) {
      const waitTime = this.minRequestInterval - timeSinceLastRequest;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    this.lastRequestTimeByTokenIndex[tokenIndex] = Date.now();
  }

  private async acquireApiSlot(): Promise<() => void> {
    if (!this.apiConcurrencyLimit) {
      return () => {};
    }

    if (this.apiInFlight < this.apiConcurrencyLimit) {
      this.apiInFlight++;
      return () => this.releaseApiSlot();
    }

    await new Promise<void>((resolve) => {
      this.apiWaitQueue.push(resolve);
    });

    this.apiInFlight++;
    return () => this.releaseApiSlot();
  }

  private releaseApiSlot(): void {
    if (!this.apiConcurrencyLimit) {
      return;
    }

    this.apiInFlight = Math.max(0, this.apiInFlight - 1);
    const next = this.apiWaitQueue.shift();
    if (next) {
      next();
    }
  }

  private mapOperator(op: string): string {
    // Map internal operators to API format
    const operatorMap: Record<string, string> = {
      '$eq': '$eq',
      '$in': '$in',
      '$between': '$between',
      '$gte': '$gte',
      '$lte': '$lte',
      '$gt': '$gt',
      '$lt': '$lt',
      'eq': '$eq',
      'in': '$in',
      'between': '$between',
      'gte': '$gte',
      'lte': '$lte',
      'gt': '$gt',
      'lt': '$lt',
      '>=': '>=',
      '<=': '<=',
      '>': '>',
      '<': '<',
      '=': '=',
    };
    return operatorMap[op] || op;
  }

  private buildQueryParams(params: any): any {
    // Build query params in API format
    const queryParams: any = { ...params };

    // Convert where object to nested query format
    if (queryParams.where && typeof queryParams.where === 'object') {
      Object.keys(queryParams.where).forEach((field) => {
        const condition = queryParams.where[field];
        if (condition && typeof condition === 'object') {
          // Only add op if it exists (date ranges don't need op)
          if (condition.op) {
            queryParams[`where[${field}][op]`] = condition.op;
          }
          if (Array.isArray(condition.value)) {
            condition.value.forEach((val: any, idx: number) => {
              queryParams[`where[${field}][value][${idx}]`] = val;
            });
          } else {
            queryParams[`where[${field}][value]`] = condition.value;
          }
        }
      });
      delete queryParams.where;
    }

    return queryParams;
  }

  private async requestWithRetry(
    endpoint: string,
    params: any,
    maxRetries: number = 3
  ): Promise<any> {
    const cacheKey = this.generateCacheKey(endpoint, params);
    const cached = await this.getCached(cacheKey);

    if (cached) {
      logger.debug('Cache hit', { endpoint });
      // Track cached request (won't count in API calls)
      await this.trackZOUsage(endpoint, true);
      return cached;
    }

    let lastError: any;
    const maxTokenRotations = this.apiTokens.length;
    const useRoundRobin = (process.env.ZAKONONLINE_TOKEN_STRATEGY || '').toLowerCase() === 'round_robin';
    const firstTokenIndex = useRoundRobin ? this.getNextTokenIndex() : this.currentTokenIndex;
    
    for (let tokenAttempt = 0; tokenAttempt < maxTokenRotations; tokenAttempt++) {
      const tokenIndex = (firstTokenIndex + tokenAttempt) % this.apiTokens.length;
      const token = this.getTokenByIndex(tokenIndex);

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const releaseSlot = await this.acquireApiSlot();

          // Rate limiting: wait before making request (per token)
          await this.waitForRateLimit(tokenIndex);

          // Build query params in API format
          const queryParams = this.buildQueryParams(params);

          // DEBUG: Log the exact params being sent
          logger.info('Zakononline API request', {
            endpoint,
            queryParams: JSON.stringify(queryParams, null, 2)
          });

          try {
            const apiStart = Date.now();
            const response = await this.client.get(endpoint, {
              params: queryParams,
              // IMPORTANT: set token per request to avoid races under concurrency
              headers: {
                'X-App-Token': token,
              },
            });
            const apiDuration = (Date.now() - apiStart) / 1000;
            this.externalApiMetrics?.('zakononline', 'success', apiDuration);

            const data = response.data;
            await this.setCache(cacheKey, data);

            // Track successful API call (not cached)
            await this.trackZOUsage(endpoint, false);

            return data;
          } finally {
            releaseSlot();
          }
        } catch (error: any) {
          lastError = error;
          const status = error.response?.status;
          const isRateLimit = status === 429;
          const isAuthError = status === 401 || status === 403;
          const errLabel = isRateLimit ? 'rate_limited' : isAuthError ? 'auth_error' : 'error';
          this.externalApiMetrics?.('zakononline', errLabel, 0);

          logger.warn(`Request attempt ${attempt} failed:`, {
            message: error.message,
            status: status,
            endpoint: endpoint,
          });

          // Handle rate limiting (429 Too Many Requests)
          if (isRateLimit) {
            const retryAfter = error.response?.headers?.['retry-after']
              ? parseInt(error.response.headers['retry-after']) * 1000
              : this.rateLimitDelay * Math.pow(2, attempt - 1); // Exponential backoff

            logger.warn(`Rate limited, waiting ${retryAfter}ms before retry`);
            await new Promise((resolve) => setTimeout(resolve, retryAfter));

            // If still rate limited after retries, try next token if available
            if (attempt >= maxRetries && this.apiTokens.length > 1 && tokenAttempt < maxTokenRotations - 1) {
              break;
            }
            continue;
          }

          // If it's an auth error and we have multiple tokens, try next token
          if (isAuthError &&
              this.apiTokens.length > 1 && tokenAttempt < maxTokenRotations - 1) {
            break; // Break inner loop to try with new token
          }

          // For 500 errors, log more details
          if (status >= 500) {
            logger.error(`Server error ${status}`, {
              endpoint,
              params: params,
              response: error.response?.data,
            });
          }

          // For other errors, wait with exponential backoff
          if (attempt < maxRetries) {
            const backoffDelay = 1000 * Math.pow(2, attempt - 1);
            await new Promise((resolve) => setTimeout(resolve, backoffDelay));
          }
        }
      }
    }

    // All retries exhausted, throw appropriate error
    const zakonError = createZakonOnlineError(lastError, endpoint, params);
    throw zakonError;
  }

  async searchCourtDecisions(params: ZOSearchParams): Promise<ZOSearchResponse> {
    // Validate target if provided
    const target = params.target || this.domainConfig.defaultTarget;
    if (!isValidTarget(this.domainConfig.name, target)) {
      throw new ZakonOnlineValidationError(
        `Invalid target "${target}" for domain "${this.domainConfig.displayName}". ` +
        `Available targets: ${this.domainConfig.availableTargets.join(', ')}`
      );
    }

    // Convert params to API format according to documentation
    const apiParams: any = {
      target: target,
      mode: params.mode || 'sph04',
      limit: params.limit || 40,
    };

    // Add search query if provided (from meta.search or meta.query)
    if (params.meta?.search) {
      apiParams.search = params.meta.search;
    } else if (params.meta?.query) {
      apiParams.search = params.meta.query;
    }

    // Convert where array to API format (only if non-empty)
    if (params.where && Array.isArray(params.where) && params.where.length > 0) {
      apiParams.where = {};

      // Group conditions by field to handle date ranges
      const conditionsByField: Record<string, any[]> = {};
      params.where.forEach((condition: any) => {
        const field = condition.field;
        if (!conditionsByField[field]) {
          conditionsByField[field] = [];
        }
        conditionsByField[field].push(condition);
      });

      // Process each field's conditions
      Object.entries(conditionsByField).forEach(([field, conditions]) => {
        if (conditions.length === 1) {
          // Single condition
          const condition = conditions[0];
          const op = condition.operator || condition.op || '$eq';
          const value = condition.value;

          apiParams.where[field] = {
            op: this.mapOperator(op),
            value: value,
          };
        } else if (conditions.length === 2) {
          // Date range: check if we have >= and <= operators
          const fromCondition = conditions.find(c => (c.operator || c.op) === '>=');
          const toCondition = conditions.find(c => (c.operator || c.op) === '<=');

          if (fromCondition && toCondition) {
            // Use array format with 'between' op for date range
            apiParams.where[field] = {
              op: 'between',
              value: [fromCondition.value, toCondition.value]
            };

            logger.info('Applied date range filter', {
              field,
              from: fromCondition.value,
              to: toCondition.value
            });
          } else {
            // Fallback: use first condition
            const condition = conditions[0];
            apiParams.where[field] = {
              op: this.mapOperator(condition.operator || condition.op || '$eq'),
              value: condition.value,
            };
          }
        }
      });
    }

    // Add sorting if provided
    if (params.orderBy) {
      const { field, direction } = params.orderBy;
      apiParams[`order[${field}]`] = direction;
      logger.debug('Applied sorting', { field, direction });
    } else {
      // Default sorting by relevance weight
      apiParams['order[weight]'] = 'desc';
    }

    logger.debug('API request params', {
      endpoint: this.domainConfig.endpoints.search,
      params: apiParams
    });

    const response = await this.requestWithRetry(
      this.domainConfig.endpoints.search,
      apiParams
    );

    // Always persist fetched documents (async, deduped, batched)
    if (Array.isArray(response)) {
      this.enqueueDocumentsForPersistence(response);
    } else if (response?.data && Array.isArray(response.data)) {
      this.enqueueDocumentsForPersistence(response.data);
    }

    // DISABLED: Automatic document loading causes PostgreSQL connection pool exhaustion
    // during large pagination (10,000+ pages). Documents should be loaded explicitly
    // only when needed (e.g., for top N results to display).
    //
    // if (this.documentService && Array.isArray(response)) {
    //   this.saveDocumentsToDatabase(response).catch(err => {
    //     logger.error('Background document save failed:', err);
    //   });
    // }

    return response;
  }

  async searchCourtPractice(params: ZOSearchParams): Promise<ZOSearchResponse> {
    const response = await this.requestWithRetry('/api/court/practice', {
      ...params,
      fulldata: params.fulldata || 1,
    });
    if (Array.isArray(response)) {
      this.enqueueDocumentsForPersistence(response);
    } else if (response?.data && Array.isArray(response.data)) {
      this.enqueueDocumentsForPersistence(response.data);
    }
    return response;
  }


  /**
   * Get full document by its numeric ID via ZakonOnline API
   * Uses /v1/document/by/number/{docId} endpoint
   */
  async getDocumentByNumber(docId: string | number): Promise<any | null> {
    try {
      const endpoint = `/v1/document/by/number/${docId}`;
      logger.info(`Fetching document by number via API`, { docId, endpoint });

      const apiStart = Date.now();
      const response = await this.requestWithRetry(endpoint, {});
      const apiDuration = (Date.now() - apiStart) / 1000;

      if (response) {
        logger.info('Successfully fetched document by number via API', {
          docId,
          duration: apiDuration,
          hasText: !!(response.full_text || response.text || response.content),
        });
        return response;
      }
      return null;
    } catch (error: any) {
      logger.warn(`API document-by-number failed for ${docId}:`, error?.message);
      return null;
    }
  }

  /**
   * Get full document by its domain-specific ID via ZakonOnline API
   * Uses /v1/document/by/id/{id} endpoint
   */
  async getDocumentById(id: string | number): Promise<any | null> {
    try {
      const endpoint = `/v1/document/by/id/${id}`;
      logger.info(`Fetching document by id via API`, { id, endpoint });

      const response = await this.requestWithRetry(endpoint, {});

      if (response) {
        logger.info('Successfully fetched document by id via API', {
          id,
          hasText: !!(response.full_text || response.text || response.content),
        });
        return response;
      }
      return null;
    } catch (error: any) {
      logger.warn(`API document-by-id failed for ${id}:`, error?.message);
      return null;
    }
  }

  /**
   * Get full text of a court decision by document ID
   * Primary: API /v1/document/by/number/{docId}
   * Fallback: HTML scraping from zakononline.ua
   * Returns both HTML and extracted text
   */
  async getDocumentFullText(docId: string | number): Promise<{ html: string; text: string; case_number?: string } | null> {
    const cacheKey = `zo:fulltext:${docId}`;

    // Check cache first
    const cached = await this.getCached(cacheKey);
    if (cached) {
      logger.debug('Full text cache hit', { docId });
      await this.trackSecondLayerUsage('web_scraping', docId, true);
      return cached;
    }

    // Primary: try API endpoint
    try {
      const apiDoc = await this.getDocumentByNumber(docId);
      if (apiDoc) {
        const text = apiDoc.full_text || apiDoc.text || apiDoc.content || '';
        if (text.length > 100) {
          const result = {
            html: apiDoc.full_text_html || apiDoc.html || text,
            text: text,
            case_number: apiDoc.cause_num || apiDoc.case_number || undefined,
          };

          await this.setCache(cacheKey, result, 7 * 24 * 3600);
          await this.trackSecondLayerUsage('api_fulltext', docId, false);

          this.enqueueDocumentsForPersistence([
            {
              doc_id: docId,
              full_text: result.text,
              full_text_html: result.html,
              case_number: result.case_number,
            },
          ]);

          logger.info('Got full text via API endpoint', { docId, textLength: text.length });
          return result;
        }
      }
    } catch (error: any) {
      logger.warn(`API full text failed for ${docId}, falling back to HTML scraping:`, error?.message);
    }

    // Fallback: HTML scraping
    try {
      const url = `https://zakononline.ua/court-decisions/show/${docId}`;

      logger.info(`Fetching full text from ${url}`);

      const scrapeStart = Date.now();
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SecondLayerBot/1.0)',
        },
      });
      const scrapeDuration = (Date.now() - scrapeStart) / 1000;

      if (response.status !== 200) {
        this.externalApiMetrics?.('zakononline_scrape', 'error', scrapeDuration);
        logger.warn(`Failed to fetch document HTML, status: ${response.status}`);
        return null;
      }
      this.externalApiMetrics?.('zakononline_scrape', 'success', scrapeDuration);

      const htmlContent = response.data;

      const parser = new CourtDecisionHTMLParser(htmlContent);
      const fullText = parser.toText('full');
      const articleHTML = parser.extractArticleHTML();
      const metadata = parser.getMetadata();

      if (fullText && fullText.length > 100) {
        const result = {
          html: articleHTML,
          text: fullText,
          case_number: metadata.caseNumber || undefined
        };

        logger.info(`Successfully extracted full text using HTML parser`, {
          docId,
          textLength: fullText.length,
          htmlLength: articleHTML.length,
          originalHtmlLength: htmlContent.length,
          caseNumber: metadata.caseNumber
        });

        await this.setCache(cacheKey, result, 7 * 24 * 3600);
        await this.trackSecondLayerUsage('web_scraping', docId, false);

        this.enqueueDocumentsForPersistence([
          {
            doc_id: docId,
            full_text: result.text,
            full_text_html: result.html,
            url: `https://zakononline.ua/court-decisions/show/${docId}`,
            case_number: metadata.caseNumber || undefined
          },
        ]);

        return result;
      }

      logger.warn(`Could not extract meaningful text from document`, { docId });
      return null;

    } catch (error: any) {
      logger.error(`Failed to fetch document full text ${docId}:`, error?.message);
      return null;
    }
  }

  /**
   * Get full text of a court decision by case number
   * First searches for the case, then fetches full text from HTML page
   */
  async getDocumentByCaseNumber(caseNumber: string): Promise<any> {
    try {
      // Search for the case to get doc_id and metadata
      const searchResult = await this.searchCourtDecisions({
        meta: { search: caseNumber },
        limit: 1,
        fulldata: 1,  // Request full data
      });
      
      if (Array.isArray(searchResult) && searchResult.length > 0) {
        const doc = searchResult[0];
        
        logger.info('Found document for case number', { 
          caseNumber, 
          docId: doc.doc_id,
          hasFullTextInAPI: !!doc.full_text,
          hasSnippet: !!doc.snippet,
        });
        
        // Try to fetch full text from HTML page
        if (doc.doc_id) {
          const fullTextData = await this.getDocumentFullText(doc.doc_id);
          if (fullTextData) {
            doc.full_text = fullTextData.text;
            doc.full_text_html = fullTextData.html;
            logger.info('Successfully fetched full text from HTML', {
              docId: doc.doc_id,
              textLength: fullTextData.text.length,
              htmlLength: fullTextData.html.length,
            });
            
            // Save/update document with full text in database
            if (this.documentService) {
              this.saveDocumentToDatabase(doc).catch(err => {
                logger.error('Failed to save document with full text:', err);
              });
            }
          }
        }
        
        return doc;
      }
      
      throw new Error(`Document not found for case number: ${caseNumber}`);
    } catch (error: any) {
      logger.error(`Failed to fetch document by case number ${caseNumber}:`, error?.message);
      throw error;
    }
  }

  /**
   * Save a single document to database
   */
  private async saveDocumentToDatabase(doc: any): Promise<void> {
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
        date: doc.adjudication_date || doc.date || undefined,
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
      // Don't throw - this is a background operation
    }
  }

  /**
   * Save multiple documents to database with full text loading
   * Limited to prevent connection pool exhaustion
   * Saves in batches during loading for better performance
   */
  async saveDocumentsToDatabase(docs: any[], maxDocs: number = 1000): Promise<void> {
    if (!this.documentService || !docs.length) {
      return;
    }

    // Limit number of documents to process
    const docsToProcess = docs.slice(0, maxDocs);
    logger.info(`Processing ${docsToProcess.length} documents for database save (limited to ${maxDocs})`);

    // Filter valid documents
    const validDocs = docsToProcess.filter(doc => doc.doc_id);

    if (validDocs.length === 0) {
      return;
    }

    // Process and save in batches of 100 documents
    const SAVE_BATCH_SIZE = 100;
    let totalSaved = 0;

    for (let i = 0; i < validDocs.length; i += SAVE_BATCH_SIZE) {
      const batch = validDocs.slice(i, i + SAVE_BATCH_SIZE);
      logger.info(`Loading batch ${Math.floor(i / SAVE_BATCH_SIZE) + 1}/${Math.ceil(validDocs.length / SAVE_BATCH_SIZE)} (${batch.length} documents)`);

      // Load full texts for this batch
      const documentsWithFullText = await this.loadFullTextsForDocuments(batch);

      // Save this batch to database immediately
      try {
        const savedIds = await this.documentService.saveDocumentsBatch(documentsWithFullText);
        const withText = documentsWithFullText.filter(d => d.full_text).length;
        totalSaved += documentsWithFullText.length;
        logger.info(`Saved batch to database: ${documentsWithFullText.length} documents (${withText} with full text). Total saved: ${totalSaved}/${validDocs.length}`);

        // Extract and save sections for documents with full text
        logger.info(`Starting section extraction for ${withText} documents with full text`);
        for (let j = 0; j < documentsWithFullText.length; j++) {
          const doc = documentsWithFullText[j];
          const docId = savedIds[j];

          if (doc.full_text && doc.full_text.length > 100) {
            try {
              // Extract sections using SemanticSectionizer
              const sections = await this.sectionizer.extractSections(doc.full_text, true);

              if (sections && sections.length > 0) {
                // Save sections to database
                await this.documentService.saveSections(docId, sections);
                logger.info(`Extracted and saved ${sections.length} sections for document ${doc.zakononline_id}`);

                // Index DECISION + COURT_REASONING to vector store
                const dateYMD = this.normalizeDateToYMD(doc.date);
                if (dateYMD) {
                  const lawArticles = this.extractLawArticlesSimple(doc.full_text);
                  await this.indexSectionsToVectorStore({
                    docId,
                    sections: sections as any,
                    metadata: {
                      date: dateYMD,
                      court: doc.court,
                      chamber: doc.chamber,
                      case_number: doc.case_number,
                      dispute_category: doc.dispute_category,
                      outcome: doc.outcome,
                      deviation_flag: doc.deviation_flag,
                      law_articles: lawArticles,
                    },
                  });
                }
              } else {
                logger.warn(`No sections extracted for document ${doc.zakononline_id}`);
              }
            } catch (sectionError: any) {
              logger.error(`Failed to extract/save sections for document ${doc.zakononline_id}:`, sectionError.message);
              // Don't throw - continue with next document
            }
          }
        }
        logger.info(`Completed section extraction for batch`);
      } catch (error) {
        logger.error('Error saving documents batch to database:', error);
        // Don't throw - continue with next batch
      }
    }

    logger.info(`Completed saving ${totalSaved} documents to database`);
  }

  /**
   * Load full texts for multiple documents with concurrency control
   */
  private async loadFullTextsForDocuments(docs: any[]): Promise<any[]> {
    const envLimit = process.env.FULLTEXT_CONCURRENCY_LIMIT;
    const CONCURRENCY_LIMIT = envLimit && !Number.isNaN(Number(envLimit))
      ? Math.max(1, Number(envLimit))
      : 10; // Max 10 parallel requests to ZakonOnline API
    const results: any[] = [];

    // Process documents in batches
    for (let i = 0; i < docs.length; i += CONCURRENCY_LIMIT) {
      const batch = docs.slice(i, i + CONCURRENCY_LIMIT);

      const batchResults = await Promise.all(
        batch.map(async (doc) => {
          // Check if document already exists in DB with full text
          if (this.documentService) {
            const existing = await this.documentService.getDocumentByZoId(String(doc.doc_id));
            if (existing && existing.full_text && existing.full_text.length > 100) {
              logger.debug(`Using cached full text from database for ${doc.doc_id}`);
              const outcome = this.extractOutcome(doc.resolution || existing.full_text || null);
              const deviationFlag = this.extractDeviationFlag(existing.full_text || doc.resolution || null);
              const chamber = existing.chamber || this.extractChamberFromText(existing.full_text || doc.resolution || null);
              return {
                zakononline_id: String(doc.doc_id),
                type: 'court_decision',
                title: doc.title || doc.cause_num || undefined,
                date: doc.adjudication_date || doc.date || undefined,
                case_number: doc.cause_num || undefined,
                court: (doc.court || doc.court_name) ? String(doc.court || doc.court_name) : (doc.court_code != null ? String(doc.court_code) : undefined),
                chamber: chamber,
                dispute_category: doc.category_code != null ? String(doc.category_code) : undefined,
                outcome: outcome ?? undefined,
                deviation_flag: deviationFlag,
                full_text: existing.full_text,
                full_text_html: existing.full_text_html,
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
              };
            }
          }

          // Load full text from HTML if not in database
          let fullText: string | null = null;
          let fullTextHtml: string | null = null;
          if (doc.doc_id) {
            try {
              const fullTextData = await this.getDocumentFullText(doc.doc_id);
              if (fullTextData) {
                fullText = fullTextData.text;
                fullTextHtml = fullTextData.html;
                logger.info(`Loaded full text for document ${doc.doc_id} (text: ${fullTextData.text.length} chars, html: ${fullTextData.html.length} chars)`);
              } else {
                logger.warn(`Failed to load full text for document ${doc.doc_id}`);
              }
            } catch (error: any) {
              logger.error(`Error loading full text for ${doc.doc_id}:`, error?.message);
            }
          }

          const outcome = this.extractOutcome(doc.resolution || fullText || null);
          const deviationFlag = this.extractDeviationFlag(fullText || doc.resolution || null);
          const chamber = this.extractChamberFromText(fullText || doc.resolution || null);
          return {
            zakononline_id: String(doc.doc_id),
            type: 'court_decision',
            title: doc.title || doc.cause_num || undefined,
            date: doc.adjudication_date || doc.date || undefined,
            case_number: doc.cause_num || undefined,
            court: (doc.court || doc.court_name) ? String(doc.court || doc.court_name) : (doc.court_code != null ? String(doc.court_code) : undefined),
            chamber: chamber,
            dispute_category: doc.category_code != null ? String(doc.category_code) : undefined,
            outcome: outcome ?? undefined,
            deviation_flag: deviationFlag,
            full_text: fullText,
            full_text_html: fullTextHtml,
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
          };
        })
      );

      results.push(...batchResults);

      // Small delay between batches to respect rate limits
      if (i + CONCURRENCY_LIMIT < docs.length) {
        const batchDelayEnv = process.env.FULLTEXT_BATCH_DELAY_MS;
        const delayMs = batchDelayEnv && !Number.isNaN(Number(batchDelayEnv))
          ? Math.max(0, Number(batchDelayEnv))
          : 500;
        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }

    return results;
  }

  async normalizeResponse(response: any): Promise<any> {
    // Normalize different endpoint responses to unified format
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

  private async trackZOUsage(endpoint: string, cached: boolean): Promise<void> {
    const context = requestContext.getStore();
    if (!context || !this.costTracker) {
      return;
    }

    try {
      await this.costTracker.recordZOCall({
        requestId: context.requestId,
        endpoint: endpoint,
        cached: cached,
      });

      if (!cached) {
        logger.debug('ZO API call tracked', {
          requestId: context.requestId,
          endpoint,
        });
      }
    } catch (error) {
      logger.error('Failed to track ZO usage:', error);
      // Don't throw - we don't want to interrupt the main request
    }
  }

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
      // Don't throw - we don't want to interrupt the main request
    }
  }

  // ==================== METADATA QUERIES ====================

  /**
   * Get search metadata (total count, facets) without fetching all results
   * This is much faster than fetching all documents when you only need counts
   *
   * @param params Search parameters (same as searchCourtDecisions)
   * @returns Metadata including total count and facets
   */
  async getSearchMetadata(params: ZOSearchParams): Promise<any> {
    // Validate target if provided
    const target = params.target || this.domainConfig.defaultTarget;
    if (!isValidTarget(this.domainConfig.name, target)) {
      throw new ZakonOnlineValidationError(
        `Invalid target "${target}" for domain "${this.domainConfig.displayName}". ` +
        `Available targets: ${this.domainConfig.availableTargets.join(', ')}`
      );
    }

    const apiParams: any = {
      target: target,
      mode: params.mode || 'sph04',
    };

    // Add search query
    if (params.meta?.search) {
      apiParams.search = params.meta.search;
    } else if (params.meta?.query) {
      apiParams.search = params.meta.query;
    }

    // Add where conditions
    if (params.where && Array.isArray(params.where) && params.where.length > 0) {
      // Use same logic as searchCourtDecisions
      apiParams.where = {};

      const conditionsByField: Record<string, any[]> = {};
      params.where.forEach((condition: any) => {
        const field = condition.field;
        if (!conditionsByField[field]) {
          conditionsByField[field] = [];
        }
        conditionsByField[field].push(condition);
      });

      Object.entries(conditionsByField).forEach(([field, conditions]) => {
        if (conditions.length === 1) {
          const condition = conditions[0];
          const op = condition.operator || condition.op || '$eq';
          apiParams.where[field] = {
            op: this.mapOperator(op),
            value: condition.value,
          };
        } else if (conditions.length === 2) {
          const fromCondition = conditions.find(c => (c.operator || c.op) === '>=');
          const toCondition = conditions.find(c => (c.operator || c.op) === '<=');

          if (fromCondition && toCondition) {
            apiParams.where[field] = {
              value: [fromCondition.value, toCondition.value]
            };
          }
        }
      });
    }

    logger.debug('Fetching metadata', {
      endpoint: this.domainConfig.endpoints.meta,
      params: apiParams
    });

    return this.requestWithRetry(this.domainConfig.endpoints.meta, apiParams);
  }

  // ==================== REFERENCE DICTIONARIES ====================

  /**
   * Get reference dictionary data
   * Generic method for fetching any dictionary available in current domain
   *
   * @param dictionaryName Name of dictionary (e.g., 'courts', 'judges')
   * @param params Optional pagination parameters
   */
  async getDictionary(
    dictionaryName: string,
    params?: { limit?: number; page?: number; nolimits?: number }
  ): Promise<any> {
    const endpoint = this.domainConfig.endpoints.dictionaries[dictionaryName];

    if (!endpoint) {
      const available = Object.keys(this.domainConfig.endpoints.dictionaries).join(', ');
      throw new ZakonOnlineValidationError(
        `Dictionary "${dictionaryName}" not available for domain "${this.domainConfig.displayName}". ` +
        `Available dictionaries: ${available || 'none'}`
      );
    }

    logger.debug(`Fetching ${dictionaryName} dictionary`, { endpoint, params });

    return this.requestWithRetry(endpoint, params || {});
  }

  // Court Decisions domain dictionaries

  /**
   * Get courts dictionary (Court Decisions domain only)
   */
  async getCourtsDictionary(params?: { limit?: number; page?: number }): Promise<any> {
    return this.getDictionary('courts', params);
  }

  /**
   * Get instances dictionary (Court Decisions domain only)
   */
  async getInstancesDictionary(): Promise<any> {
    return this.getDictionary('instances');
  }

  /**
   * Get judgment forms dictionary (Court Decisions domain only)
   */
  async getJudgmentFormsDictionary(): Promise<any> {
    return this.getDictionary('judgmentForms');
  }

  /**
   * Get justice kinds dictionary (available in Court Decisions and Court Sessions)
   */
  async getJusticeKindsDictionary(): Promise<any> {
    return this.getDictionary('justiceKinds');
  }

  /**
   * Get regions dictionary (Court Decisions domain only)
   */
  async getRegionsDictionary(): Promise<any> {
    return this.getDictionary('regions');
  }

  /**
   * Get judges dictionary (Court Decisions domain only)
   */
  async getJudgesDictionary(params?: { limit?: number; page?: number }): Promise<any> {
    return this.getDictionary('judges', params);
  }

  // Legal Acts domain dictionaries

  /**
   * Get document types dictionary (Legal Acts domain only)
   */
  async getDocumentTypesDictionary(): Promise<any> {
    return this.getDictionary('documentTypes');
  }

  /**
   * Get authors dictionary (Legal Acts domain only)
   */
  async getAuthorsDictionary(): Promise<any> {
    return this.getDictionary('authors');
  }

  // Court Practice domain dictionaries

  /**
   * Get categories dictionary (Court Practice domain only)
   */
  async getCategoriesDictionary(): Promise<any> {
    return this.getDictionary('categories');
  }

  /**
   * Get types dictionary (Court Practice domain only)
   */
  async getTypesDictionary(): Promise<any> {
    return this.getDictionary('types', { nolimits: 1 });
  }

  /**
   * List all available dictionaries for current domain
   */
  getAvailableDictionaries(): string[] {
    return Object.keys(this.domainConfig.endpoints.dictionaries);
  }
}
