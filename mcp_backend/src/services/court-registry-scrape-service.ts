/**
 * Court Registry Scrape Service (LEG-53)
 *
 * Manages checkpoints, queue, and stats for reyestr.court.gov.ua scraping.
 */

import type { Database } from '../database/database.js';
import crypto from 'crypto';

export interface ScrapeConfig {
  justiceKind: string;
  docForm: string;
  searchText?: string;
  dateFrom: string;
}

export interface Checkpoint {
  id: string;
  scrape_config_hash: string;
  last_page: number;
  last_scraped_at: Date | null;
  documents_scraped: number;
  documents_failed: number;
  status: 'in_progress' | 'completed' | 'failed';
}

export class CourtRegistryScrapeService {
  constructor(private db: Database) {}

  /**
   * Hash excludes dateFrom so incremental mode works: when effectiveDateFrom
   * changes (since last run), we still find the same checkpoint.
   */
  hashConfig(config: ScrapeConfig): string {
    const str = `${config.justiceKind}|${config.docForm}|${config.searchText || ''}`;
    return crypto.createHash('sha256').update(str).digest('hex').slice(0, 32);
  }

  async getCheckpoint(config: ScrapeConfig): Promise<Checkpoint | null> {
    const hash = this.hashConfig(config);
    const res = await this.db.query(
      'SELECT * FROM court_registry_scrape_checkpoints WHERE scrape_config_hash = $1',
      [hash]
    );
    return res.rows[0] ? this.mapCheckpoint(res.rows[0]) : null;
  }

  async upsertCheckpoint(
    config: ScrapeConfig,
    lastPage: number,
    documentsScraped: number,
    documentsFailed: number,
    status: 'in_progress' | 'completed' | 'failed',
    errorMessage?: string
  ): Promise<Checkpoint> {
    const hash = this.hashConfig(config);
    await this.db.query(
      `INSERT INTO court_registry_scrape_checkpoints (
        scrape_config_hash, justice_kind, doc_form, search_text, date_from,
        last_page, documents_scraped, documents_failed, status, error_message, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      ON CONFLICT (scrape_config_hash)
      DO UPDATE SET
        last_page = EXCLUDED.last_page,
        documents_scraped = EXCLUDED.documents_scraped,
        documents_failed = EXCLUDED.documents_failed,
        status = EXCLUDED.status,
        error_message = EXCLUDED.error_message,
        last_scraped_at = CASE WHEN EXCLUDED.status IN ('completed', 'failed') THEN NOW() ELSE court_registry_scrape_checkpoints.last_scraped_at END,
        updated_at = NOW()`,
      [
        hash,
        config.justiceKind,
        config.docForm,
        config.searchText || null,
        config.dateFrom,
        lastPage,
        documentsScraped,
        documentsFailed,
        status,
        errorMessage || null,
      ]
    );
    const r = await this.db.query(
      'SELECT * FROM court_registry_scrape_checkpoints WHERE scrape_config_hash = $1',
      [hash]
    );
    return this.mapCheckpoint(r.rows[0]);
  }

  async enqueueUrls(
    checkpointId: string,
    items: { docId: string; url: string; pageNumber: number }[]
  ): Promise<number> {
    if (items.length === 0) return 0;
    const docIds = items.map((i) => i.docId);
    const urls = items.map((i) => i.url);
    const pageNumbers = items.map((i) => i.pageNumber);
    const res = await this.db.query(
      `INSERT INTO court_registry_scrape_queue (doc_id, url, page_number, checkpoint_id, status)
       SELECT unnest($1::varchar[]), unnest($2::text[]), unnest($3::int[]), $4::uuid, 'pending'
       ON CONFLICT (doc_id) DO NOTHING`,
      [docIds, urls, pageNumbers, checkpointId]
    );
    return res.rowCount ?? 0;
  }

  /** Queue methods (getNextBatch, markCompleted, markFailed) reserved for future discovery/extraction mode. */

  async recordStats(
    runId: string,
    checkpointId: string | null,
    success: number,
    fail: number,
    captcha: number,
    block: number,
    durationSec: number
  ): Promise<void> {
    const total = success + fail;
    const successRate = total > 0 ? success / total : 0;
    await this.db.query(
      `INSERT INTO court_registry_scrape_stats (run_id, checkpoint_id, success_count, fail_count, captcha_count, block_count, duration_sec, success_rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [runId, checkpointId, success, fail, captcha, block, durationSec, successRate]
    );
  }

  private mapCheckpoint(row: Record<string, unknown>): Checkpoint {
    return {
      id: row.id as string,
      scrape_config_hash: row.scrape_config_hash as string,
      last_page: Number(row.last_page),
      last_scraped_at: row.last_scraped_at as Date | null,
      documents_scraped: Number(row.documents_scraped),
      documents_failed: Number(row.documents_failed),
      status: row.status as 'in_progress' | 'completed' | 'failed',
    };
  }
}
