/**
 * Scrape Worker Service
 *
 * Handles court decision scraping with concurrency control.
 * Designed to run in the document-service container, isolating heavy
 * HTML scraping, section extraction, and embedding generation from the main API.
 *
 * Features:
 * - Semaphore-based concurrency limiting (max 10 concurrent scrapes)
 * - Rate limiting for zakononline.ua (5 req/sec)
 * - Single-doc and batch scraping
 * - In-memory job tracking for bulk operations
 */

import axios from 'axios';
import { CourtDecisionHTMLParser } from '../utils/html-parser.js';
import { SemanticSectionizer } from '../services/semantic-sectionizer.js';
import { EmbeddingService } from '../services/embedding-service.js';
import { DocumentService } from '../services/document-service.js';
import { ZOAdapter } from '../adapters/zo-adapter.js';
import { logger } from '../utils/logger.js';
import { SectionType } from '../types/index.js';

// --- Types ---

export interface ScrapeResult {
  doc_id: string;
  full_text: string | null;
  full_text_html: string | null;
  case_number?: string;
  sections_count: number;
  embeddings_count: number;
  cached: boolean;
  error?: string;
}

export interface BulkScrapeRequest {
  keywords: string[];
  justice_kind?: number;
  date_from?: string;
  date_to?: string;
  max_docs?: number;
  batch_size?: number;
}

export interface BulkScrapeJob {
  job_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  total: number;
  processed: number;
  errors: number;
  error_details: string[];
  started_at: string;
  completed_at?: string;
}

// --- Semaphore ---

class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private max: number) {}

  async acquire(): Promise<() => void> {
    if (this.current < this.max) {
      this.current++;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.current = Math.max(0, this.current - 1);
    const next = this.queue.shift();
    if (next) next();
  }

  get pending(): number {
    return this.queue.length;
  }

  get inFlight(): number {
    return this.current;
  }
}

// --- Service ---

export class ScrapeWorkerService {
  private semaphore: Semaphore;
  private sectionizer: SemanticSectionizer;
  private jobs: Map<string, BulkScrapeJob> = new Map();
  private lastScrapeTime = 0;
  private readonly minScrapeInterval: number;

  constructor(
    private documentService: DocumentService,
    private embeddingService: EmbeddingService,
    private zoAdapter: ZOAdapter,
  ) {
    const maxConcurrent = parseInt(process.env.SCRAPE_MAX_CONCURRENT || '10', 10);
    this.semaphore = new Semaphore(maxConcurrent);
    this.sectionizer = new SemanticSectionizer();
    // Rate limit: 5 req/sec = 200ms between requests
    this.minScrapeInterval = parseInt(process.env.SCRAPE_MIN_INTERVAL_MS || '200', 10);
  }

  /**
   * Scrape a single court decision: fetch HTML, parse, extract sections, embed, save
   */
  async scrapeAndProcess(docId: string, metadata?: Record<string, any>): Promise<ScrapeResult> {
    const release = await this.semaphore.acquire();

    try {
      // Check if already in DB with full text
      const existing = await this.documentService.getDocumentByZoId(String(docId));
      if (existing && existing.full_text && existing.full_text.length > 100) {
        logger.debug(`Document ${docId} already has full text in DB, returning cached`);
        return {
          doc_id: String(docId),
          full_text: existing.full_text,
          full_text_html: existing.full_text_html || null,
          case_number: existing.case_number || undefined,
          sections_count: 0,
          embeddings_count: 0,
          cached: true,
        };
      }

      // Rate limit
      await this.waitForRateLimit();

      // Fetch HTML from zakononline
      const fullTextData = await this.fetchFullText(docId);
      if (!fullTextData) {
        return {
          doc_id: String(docId),
          full_text: null,
          full_text_html: null,
          sections_count: 0,
          embeddings_count: 0,
          cached: false,
          error: 'Failed to fetch document HTML',
        };
      }

      // Save document to PG
      await this.documentService.saveDocument({
        zakononline_id: String(docId),
        type: metadata?.judgment_form || 'court_decision',
        title: metadata?.title || metadata?.cause_num || undefined,
        date: metadata?.adjudication_date || metadata?.date || undefined,
        case_number: fullTextData.case_number || metadata?.cause_num || undefined,
        court: metadata?.court || metadata?.court_name || undefined,
        full_text: fullTextData.text,
        full_text_html: fullTextData.html,
        metadata: metadata || {},
      });

      // Extract sections (skip embeddings during bulk to save memory)
      let sectionsCount = 0;
      let embeddingsCount = 0;
      const skipEmbeddings = (process.env.SCRAPE_SKIP_EMBEDDINGS || '').toLowerCase() === 'true';

      try {
        const sections = await this.sectionizer.extractSections(fullTextData.text, true);
        if (sections && sections.length > 0) {
          // Get the document ID from DB to save sections
          const doc = await this.documentService.getDocumentByZoId(String(docId));
          if (doc && doc.id) {
            await this.documentService.saveSections(doc.id, sections);
            sectionsCount = sections.length;

            // Generate embeddings for key sections (can be skipped to save memory)
            if (!skipEmbeddings) {
              embeddingsCount = await this.indexSections(
                doc.id,
                String(docId),
                sections,
                fullTextData.text,
                metadata,
              );
            }
          }
        }
      } catch (sectionError: any) {
        logger.error(`Section extraction failed for ${docId}:`, sectionError.message);
      }

      return {
        doc_id: String(docId),
        full_text: fullTextData.text,
        full_text_html: fullTextData.html,
        case_number: fullTextData.case_number,
        sections_count: sectionsCount,
        embeddings_count: embeddingsCount,
        cached: false,
      };
    } catch (error: any) {
      logger.error(`scrapeAndProcess failed for ${docId}:`, error.message);
      return {
        doc_id: String(docId),
        full_text: null,
        full_text_html: null,
        sections_count: 0,
        embeddings_count: 0,
        cached: false,
        error: error.message,
      };
    } finally {
      release();
    }
  }

  /**
   * Start a bulk scrape job (runs in background)
   */
  async startBulkScrape(request: BulkScrapeRequest): Promise<string> {
    const jobId = `bulk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job: BulkScrapeJob = {
      job_id: jobId,
      status: 'queued',
      progress: 0,
      total: 0,
      processed: 0,
      errors: 0,
      error_details: [],
      started_at: new Date().toISOString(),
    };

    this.jobs.set(jobId, job);

    // Run in background
    this.runBulkScrape(jobId, request).catch((error) => {
      logger.error(`Bulk scrape job ${jobId} failed:`, error);
      const j = this.jobs.get(jobId);
      if (j) {
        j.status = 'failed';
        j.error_details.push(error.message);
        j.completed_at = new Date().toISOString();
      }
    });

    return jobId;
  }

  /**
   * Get job status
   */
  getJobStatus(jobId: string): BulkScrapeJob | null {
    return this.jobs.get(jobId) || null;
  }

  /**
   * Get queue depth for backpressure
   */
  getQueueDepth(): { in_flight: number; pending: number } {
    return {
      in_flight: this.semaphore.inFlight,
      pending: this.semaphore.pending,
    };
  }

  // --- Private ---

  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastScrapeTime;
    if (elapsed < this.minScrapeInterval) {
      await new Promise((resolve) => setTimeout(resolve, this.minScrapeInterval - elapsed));
    }
    this.lastScrapeTime = Date.now();
  }

  private async fetchFullText(
    docId: string | number,
  ): Promise<{ html: string; text: string; case_number?: string } | null> {
    // Use FULLTEXT_STRATEGY=scrape_only to skip useless API call
    const scrapeOnly = (process.env.FULLTEXT_STRATEGY || 'scrape_only').toLowerCase() === 'scrape_only';

    if (!scrapeOnly) {
      // Try API endpoint first
      try {
        const apiDoc = await this.zoAdapter.getDocumentByNumber(docId);
        if (apiDoc) {
          const text = apiDoc.full_text || apiDoc.text || apiDoc.content || '';
          if (text.length > 100) {
            return {
              html: apiDoc.full_text_html || apiDoc.html || text,
              text,
              case_number: apiDoc.cause_num || apiDoc.case_number || undefined,
            };
          }
        }
      } catch (error: any) {
        logger.warn(`API fulltext failed for ${docId}, falling back to scraping:`, error.message);
      }
    }

    // HTML scraping
    try {
      const url = `https://zakononline.ua/court-decisions/show/${docId}`;
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

      const parser = new CourtDecisionHTMLParser(response.data);
      const fullText = parser.toText('full');
      const articleHTML = parser.extractArticleHTML();
      const metadata = parser.getMetadata();

      if (fullText && fullText.length > 100) {
        return {
          html: articleHTML,
          text: fullText,
          case_number: metadata.caseNumber || undefined,
        };
      }

      logger.warn(`Could not extract meaningful text from document ${docId}`);
      return null;
    } catch (error: any) {
      logger.error(`Failed to fetch document HTML for ${docId}:`, error.message);
      return null;
    }
  }

  private async indexSections(
    dbDocId: string,
    zoDocId: string,
    sections: Array<{ type: SectionType; text: string }>,
    fullText: string,
    metadata?: Record<string, any>,
  ): Promise<number> {
    if (!this.embeddingService) return 0;

    const indexable = sections.filter(
      (s) => s.type === SectionType.DECISION || s.type === SectionType.COURT_REASONING,
    );
    if (indexable.length === 0) return 0;

    let count = 0;
    for (const section of indexable) {
      const chunks = this.embeddingService.splitIntoChunks(section.text);
      if (chunks.length === 0) continue;

      const embeddings = await this.embeddingService.generateEmbeddingsBatch(chunks);
      const nowIso = new Date().toISOString();

      await Promise.all(
        chunks.map((chunk, i) =>
          this.embeddingService.storeChunk({
            id: '',
            source: 'zakononline',
            doc_id: zoDocId,
            section_type: section.type,
            text: chunk,
            embedding: embeddings[i],
            metadata: {
              date: metadata?.adjudication_date || metadata?.date || '',
              court: metadata?.court || metadata?.court_name || '',
              case_number: metadata?.cause_num || '',
            },
            created_at: nowIso,
          }),
        ),
      );
      count += chunks.length;
    }
    return count;
  }

  private async runBulkScrape(jobId: string, request: BulkScrapeRequest): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = 'running';

    const maxDocs = request.max_docs || 1000;
    const batchSize = request.batch_size || 30;
    const now = new Date();
    const threeYearsAgo = new Date(now);
    threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
    const dateFrom = request.date_from || threeYearsAgo.toISOString().split('T')[0];
    const dateTo = request.date_to || now.toISOString().split('T')[0];

    const seenIds = new Set<string>();
    const allDocs: any[] = [];

    // Phase 1: Search for documents via ZO API
    logger.info(`Bulk scrape ${jobId}: searching for documents`, {
      keywords: request.keywords,
      dateFrom,
      dateTo,
      maxDocs,
    });

    for (const keyword of request.keywords) {
      if (seenIds.size >= maxDocs) break;

      for (let page = 1; page <= 50; page++) {
        if (seenIds.size >= maxDocs) break;

        try {
          const where: any[] = [
            { field: 'adjudication_date', operator: '>=', value: dateFrom },
            { field: 'adjudication_date', operator: '<=', value: dateTo },
          ];
          if (request.justice_kind != null) {
            where.push({ field: 'justice_kind', operator: '=', value: request.justice_kind });
          }

          const response = await this.zoAdapter.searchCourtDecisions({
            meta: { search: keyword },
            where,
            limit: 100,
            page,
            orderBy: { field: 'adjudication_date', direction: 'desc' },
          });

          const items = Array.isArray(response) ? response : response?.data || [];
          if (items.length === 0) break;

          for (const doc of items) {
            const docId = String(doc.doc_id || doc.id);
            if (!docId || docId === 'undefined') continue;
            if (!seenIds.has(docId)) {
              seenIds.add(docId);
              allDocs.push(doc);
              if (seenIds.size >= maxDocs) break;
            }
          }

          if (items.length < 100) break;
        } catch (error: any) {
          logger.error(`Bulk search error [${keyword}] page ${page}:`, error.message);
          job.errors++;
          job.error_details.push(`Search error: ${error.message}`);
          if (job.error_details.length > 100) job.error_details.shift();
        }
      }
    }

    job.total = allDocs.length;
    logger.info(`Bulk scrape ${jobId}: found ${allDocs.length} unique documents, starting scraping`);

    // Phase 2: Scrape in batches
    for (let i = 0; i < allDocs.length; i += batchSize) {
      const batch = allDocs.slice(i, i + batchSize);

      const results = await Promise.all(
        batch.map((doc) =>
          this.scrapeAndProcess(String(doc.doc_id || doc.id), doc).catch((error: any) => {
            job.errors++;
            job.error_details.push(`${doc.doc_id}: ${error.message}`);
            if (job.error_details.length > 100) job.error_details.shift();
            return null;
          }),
        ),
      );

      job.processed += results.filter((r) => r != null).length;
      job.progress = Math.round((job.processed / job.total) * 100);

      logger.info(`Bulk scrape ${jobId}: ${job.processed}/${job.total} (${job.progress}%)`);

      // GC pause between batches
      if (i + batchSize < allDocs.length) {
        if (global.gc) global.gc();
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    job.status = 'completed';
    job.progress = 100;
    job.completed_at = new Date().toISOString();

    logger.info(`Bulk scrape ${jobId} completed: ${job.processed} processed, ${job.errors} errors`);
  }
}
