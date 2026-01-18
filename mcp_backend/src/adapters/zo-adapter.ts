import axios, { AxiosInstance } from 'axios';
import { createClient } from 'redis';
import { CourtDecisionHTMLParser } from '../utils/html-parser.js';
import { logger } from '../utils/logger.js';
import { DocumentService } from '../services/document-service.js';
import { requestContext } from '../utils/openai-client.js';
import type { CostTracker } from '../services/cost-tracker.js';

interface ZOSearchParams {
  where?: any[];
  meta?: any;
  fulldata?: number;
  limit?: number;
  offset?: number;
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
  private apiTokens: string[];
  private currentTokenIndex: number = 0;
  private baseURL = 'https://court.searcher.api.zakononline.com.ua';
  private lastRequestTime: number = 0;
  private minRequestInterval: number = 200; // Minimum 200ms between requests (5 req/sec max)
  private rateLimitDelay: number = 1000; // Delay when rate limited
  private costTracker: CostTracker | null = null;

  constructor(documentService?: DocumentService) {
    this.documentService = documentService || null;
    
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
      logger.info('Using secondary Zakononline token (ZAKONONLINE_API_TOKEN2)');
    } else {
      this.currentTokenIndex = 0;
      logger.info('Using primary Zakononline token (ZAKONONLINE_API_TOKEN)');
    }
    
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 30000,
      headers: {
        'X-App-Token': this.getCurrentToken(),
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    });

    this.initializeRedis();
  }

  private getCurrentToken(): string {
    return this.apiTokens[this.currentTokenIndex];
  }

  private rotateToken() {
    if (this.apiTokens.length > 1) {
      this.currentTokenIndex = (this.currentTokenIndex + 1) % this.apiTokens.length;
      this.client.defaults.headers['X-App-Token'] = this.getCurrentToken();
      logger.info('Rotated to secondary Zakononline token');
    }
  }

  setCostTracker(tracker: CostTracker) {
    this.costTracker = tracker;
    logger.debug('Cost tracker attached to ZOAdapter');
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
  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.minRequestInterval) {
      const waitTime = this.minRequestInterval - timeSinceLastRequest;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
    
    this.lastRequestTime = Date.now();
  }

  private mapOperator(op: string): string {
    // Map internal operators to API format
    const operatorMap: Record<string, string> = {
      '$eq': '$eq',
      '$in': '$in',
      '$between': '$between',
      '$gte': '$gte',
      '$lte': '$lte',
      'eq': '$eq',
      'in': '$in',
      'between': '$between',
      'gte': '$gte',
      'lte': '$lte',
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
          queryParams[`where[${field}][op]`] = condition.op;
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

    // Rate limiting: wait before making request
    await this.waitForRateLimit();

    let lastError: any;
    const maxTokenRotations = this.apiTokens.length;
    
    for (let tokenAttempt = 0; tokenAttempt < maxTokenRotations; tokenAttempt++) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          // Build query params in API format
          const queryParams = this.buildQueryParams(params);
          const response = await this.client.get(endpoint, { params: queryParams });
          const data = response.data;
          await this.setCache(cacheKey, data);

          // Track successful API call (not cached)
          await this.trackZOUsage(endpoint, false);

          return data;
        } catch (error: any) {
          lastError = error;
          const status = error.response?.status;
          const isRateLimit = status === 429;
          const isAuthError = status === 401 || status === 403;
          
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
              this.rotateToken();
              break;
            }
            continue;
          }
          
          // If it's an auth error and we have multiple tokens, try next token
          if (isAuthError && 
              this.apiTokens.length > 1 && tokenAttempt < maxTokenRotations - 1) {
            this.rotateToken();
            break; // Break inner loop to try with new token
          }
          
          // For other errors, wait with exponential backoff
          if (attempt < maxRetries) {
            const backoffDelay = 1000 * Math.pow(2, attempt - 1);
            await new Promise((resolve) => setTimeout(resolve, backoffDelay));
          }
        }
      }
    }

    throw new Error(`Request failed after ${maxRetries * maxTokenRotations} attempts: ${lastError?.message}`);
  }

  async searchCourtDecisions(params: ZOSearchParams): Promise<ZOSearchResponse> {
    // Convert params to API format according to documentation
    const apiParams: any = {
      target: 'text',
      mode: 'sph04',
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
      params.where.forEach((condition: any) => {
        const field = condition.field;
        const op = condition.operator || condition.op || '$eq';
        const value = condition.value;
        
        // Map operators to API format
        const apiOp = this.mapOperator(op);
        apiParams.where[field] = {
          op: apiOp,
          value: value,
        };
      });
    }

    // Add order if provided (skip for now to avoid issues)
    // The API returns results in relevance order by default

    logger.debug('API request params', { endpoint: '/v1/search', params: apiParams });

    const response = await this.requestWithRetry('/v1/search', apiParams);

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
    return this.requestWithRetry('/api/court/practice', {
      ...params,
      fulldata: params.fulldata || 1,
    });
  }

  async searchECHRPractice(params: ZOSearchParams): Promise<ZOSearchResponse> {
    return this.requestWithRetry('/api/echr/practice', {
      ...params,
      fulldata: params.fulldata || 1,
    });
  }

  async searchNPA(params: ZOSearchParams): Promise<ZOSearchResponse> {
    return this.requestWithRetry('/api/npa/search', {
      ...params,
      fulldata: params.fulldata || 1,
    });
  }

  /**
   * Get full text of a court decision by document ID from zakononline.ua
   * Downloads HTML page and extracts text content
   * Returns both HTML and extracted text
   */
  async getDocumentFullText(docId: string | number): Promise<{ html: string; text: string } | null> {
    const cacheKey = `zo:fulltext:${docId}`;

    // Check cache first
    const cached = await this.getCached(cacheKey);
    if (cached) {
      logger.debug('Full text cache hit', { docId });
      // Track cached SecondLayer call (won't count in cost)
      await this.trackSecondLayerUsage('web_scraping', docId, true);
      return cached;
    }

    try {
      const url = `https://zakononline.ua/court-decisions/show/${docId}`;
      
      logger.info(`Fetching full text from ${url}`);
      
      // Download HTML page
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SecondLayerBot/1.0)',
        },
      });
      
      if (response.status !== 200) {
        logger.warn(`Failed to fetch document HTML, status: ${response.status}`);
        return null;
      }

      const htmlContent = response.data;

      // Parse HTML using specialized court decision parser
      const parser = new CourtDecisionHTMLParser(htmlContent);
      
      // Extract full text (all content)
      const fullText = parser.toText('full');
      
      // Extract only article HTML (without page styles, scripts, navigation)
      const articleHTML = parser.extractArticleHTML();
      
      if (fullText && fullText.length > 100) {
        const result = {
          html: articleHTML,  // Only article content, not full page HTML
          text: fullText
        };

        logger.info(`Successfully extracted full text using HTML parser`, {
          docId,
          textLength: fullText.length,
          htmlLength: articleHTML.length,
          originalHtmlLength: htmlContent.length
        });

        // Cache for 7 days
        await this.setCache(cacheKey, result, 7 * 24 * 3600);

        // Track SecondLayer API call (web scraping)
        await this.trackSecondLayerUsage('web_scraping', docId, false);

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
      await this.documentService.saveDocument({
        zakononline_id: String(doc.doc_id),
        type: 'court_decision',
        title: doc.title || doc.cause_num || null,
        date: doc.adjudication_date || doc.date || null,
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
        await this.documentService.saveDocumentsBatch(documentsWithFullText);
        const withText = documentsWithFullText.filter(d => d.full_text).length;
        totalSaved += documentsWithFullText.length;
        logger.info(`Saved batch to database: ${documentsWithFullText.length} documents (${withText} with full text). Total saved: ${totalSaved}/${validDocs.length}`);
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
    const CONCURRENCY_LIMIT = 3; // Max 3 parallel requests to avoid overwhelming the server
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
              return {
                zakononline_id: String(doc.doc_id),
                type: 'court_decision',
                title: doc.title || doc.cause_num || null,
                date: doc.adjudication_date || doc.date || null,
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

          return {
            zakononline_id: String(doc.doc_id),
            type: 'court_decision',
            title: doc.title || doc.cause_num || null,
            date: doc.adjudication_date || doc.date || null,
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
        await new Promise(resolve => setTimeout(resolve, 500));
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
}
