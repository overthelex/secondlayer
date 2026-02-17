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

  hashConfig(config: ScrapeConfig): string {
    const str = `${config.justiceKind}|${config.docForm}|${config.searchText || ''}|${config.dateFrom}`;
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
    let inserted = 0;
    for (const { docId, url, pageNumber } of items) {
      const res = await this.db.query(
        `INSERT INTO court_registry_scrape_queue (doc_id, url, page_number, checkpoint_id, status)
         VALUES ($1, $2, $3, $4, 'pending')
         ON CONFLICT (doc_id) DO NOTHING`,
        [docId, url, pageNumber, checkpointId]
      );
      if (res.rowCount && res.rowCount > 0) inserted++;
    }
    return inserted;
  }

  async getNextBatch(status: string, limit: number): Promise<{ doc_id: string; url: string }[]> {
    const res = await this.db.query(
      `WITH to_claim AS (
        SELECT id FROM court_registry_scrape_queue
        WHERE status = $1
        ORDER BY page_number, created_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      UPDATE court_registry_scrape_queue
      SET status = 'in_progress', updated_at = NOW()
      WHERE id IN (SELECT id FROM to_claim)
      RETURNING doc_id, url`,
      [status, limit]
    );
    return res.rows;
  }

  async markCompleted(docId: string): Promise<void> {
    await this.db.query(
      `UPDATE court_registry_scrape_queue SET status = 'completed', scraped_at = NOW(), updated_at = NOW() WHERE doc_id = $1`,
      [docId]
    );
  }

  async markFailed(docId: string, errorMessage: string): Promise<void> {
    await this.db.query(
      `UPDATE court_registry_scrape_queue SET status = 'failed', retry_count = retry_count + 1, error_message = $2, updated_at = NOW() WHERE doc_id = $1`,
      [docId, errorMessage]
    );
  }

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
