/**
 * Import Task Service — Multi-IP concurrent download manager.
 *
 * Manages a catalog of data sources and background import tasks.
 * Each task uses multiple source IPs (10 on prod) with configurable
 * threads per IP for parallel downloads.
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';
import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';
import { normalizeApostrophes } from './legislation-search-utils.js';
import {
  CkanResource, CsvStreamParser, JsonArrayStreamParser, TabularOptions, VALUE_TRANSFORMS, latestCkanResource,
  packageShowUrl, replaceGuardError, resourcesUnchangedSince, selectCkanResources, validateTransforms, xlsxRecords,
} from './ckan-multifile-import.js';

/** Resource formats the CKAN multi-file path can read (source_config.format). */
const CKAN_FORMATS = ['json', 'csv', 'xlsx'] as const;
type CkanFormat = typeof CKAN_FORMATS[number];

/** XLSX resources are parsed in memory; anything bigger is not one of the small registers. */
const XLSX_MAX_BYTES = 50 * 1024 * 1024;

interface ResourceParseOptions extends TabularOptions {
  format: CkanFormat;
  delimiter: string;
}
import { StringDecoder } from 'string_decoder';
import type { IncomingMessage } from 'http';

/**
 * Local source addresses outgoing downloads are bound to, from IMPORT_SOURCE_IPS
 * (comma-separated). Empty = let the OS pick, which is the only thing that works on a host
 * that does not own extra addresses. Until LEXAI-2181 this was a hard-coded list of ten AWS
 * ENI addresses (172.31.x) that no longer exist since prod left AWS: every api_paginated
 * import bound its sockets to an address the host does not have and failed with
 * "Cannot fetch first page", and every task row recorded those addresses. Exported for tests.
 */
export function parseSourceIps(raw: string | undefined): string[] {
  return (raw || '').split(',').map(s => s.trim()).filter(Boolean);
}

/** Running tasks with no progress for this long are treated as orphaned (process restarted mid-run). */
const STALE_TASK_HOURS = 24;

const MAX_RETRIES = 5;
const REQUEST_TIMEOUT = 30_000;
const JSON_ARRAY_TIMEOUT = 300_000;

interface SourceCatalog {
  id: number;
  name: string;
  title: string;
  source_type: string;
  source_url: string;
  source_config: Record<string, any>;
  target_table: string;
  upsert_sql: string | null;
  default_threads_per_ip: number;
  rate_limit_ms: number;
  enabled: boolean;
}

interface ImportTask {
  id: number;
  source_id: number;
  source_name: string;
  status: string;
  ip_addresses: string[];
  threads_per_ip: number;
  total_items: number | null;
  total_pages: number | null;
  pages_done: number;
  records_imported: number;
  records_failed: number;
  current_page: number;
  started_at: string | null;
  completed_at: string | null;
  last_activity_at: string | null;
  elapsed_ms: number;
  from_page: number;
  last_error: string | null;
}

interface StartImportOpts {
  sourceName: string;
  fromPage?: number;
  threadsPerIp?: number;
  ipAddresses?: string[];
  configOverrides?: Record<string, any>;
}

// Active task abort controllers
const activeControllers = new Map<number, AbortController>();

// Per-task progress counters (in-memory for speed, flushed to DB periodically)
const taskProgress = new Map<number, {
  pagesDone: number;
  recordsImported: number;
  recordsFailed: number;
  currentPage: number;
  lastError: string | null;
  startTime: number;
}>();

/**
 * Resolve a dotted path in a JSON record. A key that is not present verbatim is matched
 * apostrophe-insensitively: Ukrainian open-data headers mix ' (U+0027), ’ (U+2019) and
 * ʼ (U+02BC), e.g. ВРП's «Прізвище, ім’я, по батькові судді». An exact-key-only lookup
 * silently yields null for such a column (LEXAI-2117). Exported for tests.
 */
export function getJsonPath(obj: any, path: string): any {
  if (!path) return obj;
  let v: any = obj;
  for (const part of path.split('.')) {
    if (v == null) return null;
    if (typeof v === 'object' && !(part in v)) {
      const want = normalizeApostrophes(part);
      const alt = Object.keys(v).find(k => normalizeApostrophes(k) === want);
      v = alt === undefined ? undefined : v[alt];
    } else {
      v = (v as any)[part];
    }
  }
  return v;
}

/**
 * Mapped columns whose source path resolves in none of the records — the signature of a
 * renamed/misspelt header, which would otherwise load as an all-NULL column. Exported for tests.
 */
export function unresolvedMappingColumns(records: any[], mapping: Record<string, string>): string[] {
  if (records.length === 0) return [];
  return Object.entries(mapping)
    .filter(([, path]) => !records.some(rec => getJsonPath(rec, path) !== undefined))
    .map(([col]) => col);
}

/** Catalog-supplied table/column names are interpolated into SQL; allow plain identifiers only. */
function assertIdentifier(name: string): void {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`invalid SQL identifier in source_config: ${name}`);
}

export class ImportTaskService {
  constructor(private db: Database) {}

  // ========================= Catalog =========================

  async listSources(): Promise<SourceCatalog[]> {
    const res = await this.db.query('SELECT * FROM import_source_catalog ORDER BY id');
    return res.rows;
  }

  async addSource(src: Omit<SourceCatalog, 'id' | 'enabled'>): Promise<SourceCatalog> {
    const res = await this.db.query(
      `INSERT INTO import_source_catalog (name, title, source_type, source_url, source_config, target_table, upsert_sql, default_threads_per_ip, rate_limit_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (name) DO UPDATE SET title=EXCLUDED.title, source_url=EXCLUDED.source_url, source_config=EXCLUDED.source_config
       RETURNING *`,
      [src.name, src.title, src.source_type, src.source_url, JSON.stringify(src.source_config),
       src.target_table, src.upsert_sql, src.default_threads_per_ip, src.rate_limit_ms]
    );
    return res.rows[0];
  }

  // ========================= Tasks =========================

  async listTasks(filter?: { status?: string }): Promise<ImportTask[]> {
    let sql = 'SELECT * FROM import_tasks ORDER BY created_at DESC LIMIT 50';
    const params: any[] = [];
    if (filter?.status) {
      sql = 'SELECT * FROM import_tasks WHERE status = $1 ORDER BY created_at DESC LIMIT 50';
      params.push(filter.status);
    }
    const res = await this.db.query(sql, params);
    // Merge in-memory progress for running tasks
    return res.rows.map((row: any) => {
      const mem = taskProgress.get(row.id);
      if (mem && row.status === 'running') {
        return {
          ...row,
          pages_done: mem.pagesDone,
          records_imported: mem.recordsImported,
          records_failed: mem.recordsFailed,
          current_page: mem.currentPage,
          last_error: mem.lastError,
          elapsed_ms: Date.now() - mem.startTime,
        };
      }
      return row;
    });
  }

  async getTaskStatus(taskId: number): Promise<any> {
    const res = await this.db.query('SELECT t.*, c.title, c.source_type, c.source_url FROM import_tasks t JOIN import_source_catalog c ON t.source_id = c.id WHERE t.id = $1', [taskId]);
    if (!res.rows.length) return null;
    const task = res.rows[0];

    const mem = taskProgress.get(taskId);
    if (mem && task.status === 'running') {
      const elapsed = Date.now() - mem.startTime;
      const rate = mem.pagesDone > 0 ? mem.pagesDone / (elapsed / 1000) : 0;
      const remainingPages = (task.total_pages || 0) - mem.pagesDone;
      const etaSeconds = rate > 0 ? remainingPages / rate : 0;

      return {
        ...task,
        pages_done: mem.pagesDone,
        records_imported: mem.recordsImported,
        records_failed: mem.recordsFailed,
        current_page: mem.currentPage,
        last_error: mem.lastError,
        elapsed_ms: elapsed,
        rate_pages_per_sec: Math.round(rate * 100) / 100,
        eta_seconds: Math.round(etaSeconds),
        eta_human: etaSeconds > 60 ? `${Math.round(etaSeconds / 60)}m` : `${Math.round(etaSeconds)}s`,
        progress_pct: task.total_pages ? Math.round((mem.pagesDone / task.total_pages) * 100) : null,
      };
    }
    return task;
  }

  async cancelTask(taskId: number): Promise<boolean> {
    const ctrl = activeControllers.get(taskId);
    if (ctrl) {
      ctrl.abort();
      activeControllers.delete(taskId);
    }
    await this.db.query(
      `UPDATE import_tasks SET status = 'cancelled', completed_at = NOW(), updated_at = NOW() WHERE id = $1 AND status IN ('running', 'pending', 'paused')`,
      [taskId]
    );
    taskProgress.delete(taskId);
    return true;
  }

  // ========================= Start Import =========================

  async startImport(opts: StartImportOpts): Promise<{ taskId: number; message: string }> {
    // Look up source
    const srcRes = await this.db.query('SELECT * FROM import_source_catalog WHERE name = $1', [opts.sourceName]);
    if (!srcRes.rows.length) {
      throw new Error(`Source "${opts.sourceName}" not found in catalog`);
    }
    const source: SourceCatalog = srcRes.rows[0];
    // A disabled source used to run anyway (court_case_status, disabled for LEXAI-2173, still
    // got a failing task every Sunday), so «disabled» was only a label. Refuse it here.
    if (source.enabled === false) {
      const why = source.source_config?.disabled_reason;
      throw new Error(`Джерело "${source.name}" вимкнено${why ? `: ${why}` : ''}`);
    }

    await this.failOrphanedTasks(source.id);

    const ips = opts.ipAddresses || parseSourceIps(process.env.IMPORT_SOURCE_IPS);
    const threadsPerIp = opts.threadsPerIp || source.default_threads_per_ip;

    // Create the task record, at most one active task per source: two concurrent runs of a
    // replace source would race their full-table swaps (and double the download). The
    // advisory lock serialises the check + insert across backend instances.
    const taskId: number = await this.db.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('import_task_start'), $1)`, [source.id]);
      const active = await client.query(
        `SELECT id FROM import_tasks WHERE source_id = $1 AND status IN ('running', 'pending') ORDER BY id LIMIT 1`,
        [source.id],
      );
      if (active.rows.length) {
        throw new Error(`Імпорт "${source.name}" вже виконується (задача #${active.rows[0].id})`);
      }
      const taskRes = await client.query(
        `INSERT INTO import_tasks (source_id, source_name, status, ip_addresses, threads_per_ip, from_page, config_overrides, started_at)
         VALUES ($1, $2, 'running', $3, $4, $5, $6, NOW()) RETURNING id`,
        [source.id, source.name, ips, threadsPerIp, opts.fromPage || 1, JSON.stringify(opts.configOverrides || {})]
      );
      return taskRes.rows[0].id;
    });

    // Init in-memory progress
    taskProgress.set(taskId, {
      pagesDone: 0,
      recordsImported: 0,
      recordsFailed: 0,
      currentPage: opts.fromPage || 1,
      lastError: null,
      startTime: Date.now(),
    });

    // Create abort controller
    const controller = new AbortController();
    activeControllers.set(taskId, controller);

    // Launch background worker
    this.runImport(taskId, source, ips, threadsPerIp, opts.fromPage || 1, controller.signal).catch(err => {
      logger.error(`[ImportTask ${taskId}] Fatal error`, { error: err.message });
    });

    return {
      taskId,
      message: ips.length > 0
        ? `Імпорт "${source.title}" запущено. ${ips.length} IP × ${threadsPerIp} потоків = ${ips.length * threadsPerIp} паралельних завантажень.`
        : `Імпорт "${source.title}" запущено (адреса хоста за замовчуванням).`,
    };
  }

  /**
   * A task row stays 'running' forever when the backend restarts mid-import (the worker
   * lives in process memory). Before starting a source, mark its running tasks that this
   * process is not executing and that showed no progress for STALE_TASK_HOURS as failed.
   * Prod had such rows for months (e.g. #761 invalid_passports_foreign since 2026-06-23).
   */
  private async failOrphanedTasks(sourceId: number): Promise<void> {
    const res = await this.db.query(
      `SELECT id FROM import_tasks
        WHERE source_id = $1 AND status = 'running'
          AND COALESCE(last_activity_at, updated_at, started_at, created_at) < NOW() - make_interval(hours => $2)`,
      [sourceId, STALE_TASK_HOURS],
    );
    const orphaned = res.rows.map((r: any) => Number(r.id)).filter((id: number) => !activeControllers.has(id));
    if (orphaned.length === 0) return;
    await this.db.query(
      `UPDATE import_tasks SET status = 'failed', completed_at = NOW(), updated_at = NOW(),
              last_error = COALESCE(last_error || '; ', '') || $2
        WHERE id = ANY($1::int[]) AND status = 'running'`,
      [orphaned, `задача без прогресу понад ${STALE_TASK_HOURS} год (процес перезапущено під час імпорту)`],
    );
    logger.warn(`[ImportTask] Marked orphaned running tasks as failed: ${orphaned.join(', ')}`);
  }

  // ========================= Worker Pool =========================

  private async runImport(taskId: number, source: SourceCatalog, ips: string[], threadsPerIp: number, fromPage: number, signal: AbortSignal): Promise<void> {
    // No configured source addresses: one worker on the host's default address.
    const workerIps: Array<string | null> = ips.length > 0 ? ips : [null];
    const log = (msg: string, meta?: any) => logger.info(`[ImportTask ${taskId}] ${msg}`, meta);

    try {
      if (source.source_type === 'api_paginated') {
        await this.runPaginatedImport(taskId, source, workerIps, threadsPerIp, fromPage, signal);
      } else if (source.source_type === 'json_array' && source.source_config?.ckan_package) {
        await this.runCkanMultiFileImport(taskId, source, signal);
      } else if (source.source_type === 'json_array') {
        await this.runJsonArrayImport(taskId, source, signal);
      } else if (source.source_type === 'file_download') {
        await this.runFileDownloadImport(taskId, source, signal);
      } else {
        throw new Error(`Unknown source_type: ${source.source_type}`);
      }

      // Completed
      const mem = taskProgress.get(taskId);
      await this.db.query(
        `UPDATE import_tasks SET status = 'completed', completed_at = NOW(), updated_at = NOW(),
         pages_done = $2, records_imported = $3, records_failed = $4, elapsed_ms = $5
         WHERE id = $1`,
        [taskId, mem?.pagesDone || 0, mem?.recordsImported || 0, mem?.recordsFailed || 0, Date.now() - (mem?.startTime || Date.now())]
      );
      log('Completed', { records: mem?.recordsImported, errors: mem?.recordsFailed });

    } catch (err: any) {
      if (signal.aborted) {
        log('Cancelled by user');
        return;
      }
      const mem = taskProgress.get(taskId);
      await this.db.query(
        `UPDATE import_tasks SET status = 'failed', completed_at = NOW(), updated_at = NOW(),
         last_error = $2, pages_done = $3, records_imported = $4, records_failed = $5, elapsed_ms = $6
         WHERE id = $1`,
        [taskId, err.message, mem?.pagesDone || 0, mem?.recordsImported || 0, mem?.recordsFailed || 0, Date.now() - (mem?.startTime || Date.now())]
      );
      logger.error(`[ImportTask ${taskId}] Failed`, { error: err.message });
    } finally {
      activeControllers.delete(taskId);
      // Flush final progress then clean up
      const mem = taskProgress.get(taskId);
      if (mem) {
        await this.db.query(
          `UPDATE import_tasks SET pages_done = $2, records_imported = $3, records_failed = $4, elapsed_ms = $5, updated_at = NOW() WHERE id = $1`,
          [taskId, mem.pagesDone, mem.recordsImported, mem.recordsFailed, Date.now() - mem.startTime]
        ).catch(() => {});
      }
      taskProgress.delete(taskId);
    }
  }

  // ---- Paginated API (NIPO style) ----

  private async runPaginatedImport(taskId: number, source: SourceCatalog, ips: Array<string | null>, threadsPerIp: number, fromPage: number, signal: AbortSignal): Promise<void> {
    const config = source.source_config;
    const pageParam = config.page_param || 'page';
    const resultsKey = config.results_key || 'results';
    const countKey = config.count_key || 'count';

    // Fetch first page to get total
    const firstUrl = `${source.source_url}?${new URLSearchParams({ ...this.buildQueryParams(config), [pageParam]: '1' })}`;
    const firstData = await this.fetchJson(firstUrl, ips[0], signal);
    if (!firstData) throw new Error('Cannot fetch first page');

    const total = firstData[countKey] || 0;
    const perPage = (firstData[resultsKey] || []).length || 10;
    const totalPages = Math.ceil(total / perPage);

    await this.db.query('UPDATE import_tasks SET total_items = $2, total_pages = $3 WHERE id = $1', [taskId, total, totalPages]);

    logger.info(`[ImportTask ${taskId}] Total: ${total} records, ${totalPages} pages, from page ${fromPage}`);

    // Build page queue
    const pages = Array.from({ length: totalPages - fromPage + 1 }, (_, i) => fromPage + i);

    // Create worker promises — round-robin pages across IPs, 1 concurrent per IP (rate-limited)
    const ipQueues: number[][] = ips.map(() => []);
    pages.forEach((page, i) => ipQueues[i % ips.length].push(page));

    const workers = ips.map((ip, i) =>
      this.processPageQueue(taskId, source, ip, ipQueues[i], signal)
    );

    await Promise.all(workers);
  }

  private async processPageQueue(taskId: number, source: SourceCatalog, ip: string | null, pages: number[], signal: AbortSignal): Promise<void> {
    const config = source.source_config;
    const pageParam = config.page_param || 'page';
    const resultsKey = config.results_key || 'results';
    const rateLimitMs = source.rate_limit_ms || 1100;
    let flushCounter = 0;

    for (const page of pages) {
      if (signal.aborted) return;

      const url = `${source.source_url}?${new URLSearchParams({ ...this.buildQueryParams(config), [pageParam]: String(page) })}`;
      const data = await this.fetchJson(url, ip, signal);
      const records = data?.[resultsKey] || [];

      const mem = taskProgress.get(taskId);
      if (mem) {
        mem.pagesDone++;
        mem.currentPage = page;
        mem.recordsImported += records.length;
      }

      // TODO: actual upsert into target_table when upsert_sql is defined
      // For now just count — upsert logic is source-specific and will be added per-source

      // Rate limit per IP
      if (rateLimitMs > 0) {
        await this.sleep(rateLimitMs, signal);
      }

      // Flush progress to DB every 100 pages
      flushCounter++;
      if (flushCounter % 100 === 0 && mem) {
        await this.db.query(
          `UPDATE import_tasks SET pages_done = $2, records_imported = $3, records_failed = $4, current_page = $5, last_activity_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [taskId, mem.pagesDone, mem.recordsImported, mem.recordsFailed, mem.currentPage]
        ).catch(() => {});
      }
    }
  }

  // ---- JSON Array (single file download) ----

  private async runJsonArrayImport(taskId: number, source: SourceCatalog, signal: AbortSignal): Promise<void> {
    logger.info(`[ImportTask ${taskId}] Downloading JSON array from ${source.source_url}`);
    const data = await this.fetchJson(source.source_url, null, signal, JSON_ARRAY_TIMEOUT);
    if (!data) throw new Error('Cannot download JSON');

    const config = source.source_config || {};
    const rootPath: string | undefined = config.root_path;
    let records: any[];
    if (rootPath) {
      records = this.getJsonPath(data, rootPath) || [];
    } else {
      records = Array.isArray(data) ? data : (data.results || data.data || []);
    }

    const mem = taskProgress.get(taskId);
    await this.db.query('UPDATE import_tasks SET total_items = $2, total_pages = 1 WHERE id = $1', [taskId, records.length]);
    logger.info(`[ImportTask ${taskId}] Downloaded ${records.length} records`);

    const mapping = config.mapping as Record<string, string> | undefined;
    const uniqueKey = (config.unique_key as string[] | undefined) || undefined;

    const unresolved = mapping ? unresolvedMappingColumns(records, mapping) : [];
    if (unresolved.length > 0) {
      logger.warn(`[ImportTask ${taskId}] mapped columns absent from every record: ${unresolved.join(', ')}`);
    }

    // Snapshot registries without a stable natural key (row numbers are re-issued on every
    // release) are reloaded whole: DELETE + INSERT in one transaction.
    if (config.replace === true && mapping && source.target_table) {
      if (records.length === 0) throw new Error('replace import: source returned 0 records, table left as is');
      if (unresolved.length > 0) {
        throw new Error(`replace import: source has no field for ${unresolved.join(', ')}, table left as is`);
      }
      const imported = await this.replaceJsonSnapshot(source.target_table, mapping, records);
      if (mem) { mem.recordsImported = imported; mem.pagesDone = 1; }
      return;
    }

    if (!mapping || !uniqueKey?.length || !source.target_table) {
      const reason = 'upsert skipped: source_config.mapping / unique_key not configured';
      logger.warn(`[ImportTask ${taskId}] ${reason}`);
      if (mem) { mem.recordsImported = records.length; mem.pagesDone = 1; mem.lastError = reason; }
      return;
    }

    const { imported, failed } = await this.upsertJsonBatches(
      taskId, source.target_table, mapping, uniqueKey, records, signal
    );

    if (mem) {
      mem.recordsImported = imported;
      mem.recordsFailed = failed;
      mem.pagesDone = 1;
    }
  }

  private async upsertJsonBatches(
    taskId: number,
    table: string,
    mapping: Record<string, string>,
    uniqueKey: string[],
    records: any[],
    signal: AbortSignal,
  ): Promise<{ imported: number; failed: number }> {
    const cols = Object.keys(mapping);
    const paths = Object.values(mapping);

    // Pre-dedup by unique_key (last record wins) to avoid
    // "ON CONFLICT DO UPDATE cannot affect row a second time" inside a batch.
    const seen = new Map<string, any>();
    for (const rec of records) {
      const k = uniqueKey.map(col => {
        const v = this.getJsonPath(rec, mapping[col]);
        return v == null ? '' : String(v);
      }).join('\u0001');
      seen.set(k, rec);
    }
    const deduped = Array.from(seen.values());
    if (deduped.length !== records.length) {
      logger.info(`[ImportTask ${taskId}] Dedup by ${uniqueKey.join('+')}: ${records.length} → ${deduped.length}`);
    }

    const updateCols = cols.filter(c => !uniqueKey.includes(c));
    const updateSet = updateCols.map(c => `${c} = EXCLUDED.${c}`).concat(['imported_at = NOW()']).join(', ');
    const batchSize = 1000;
    let imported = 0;
    let failed = 0;

    for (let i = 0; i < deduped.length; i += batchSize) {
      if (signal.aborted) break;

      const batch = deduped.slice(i, i + batchSize);
      const params: any[] = [];
      const rowsSql: string[] = [];

      for (const rec of batch) {
        const placeholders = cols.map((_, c) => `$${params.length + c + 1}`).join(',');
        rowsSql.push(`(${placeholders})`);
        for (const p of paths) {
          const raw = this.getJsonPath(rec, p);
          params.push(this.normalizeValue(raw));
        }
      }

      const sql =
        `INSERT INTO ${table} (${cols.join(',')}) VALUES ${rowsSql.join(',')} ` +
        `ON CONFLICT (${uniqueKey.join(',')}) DO UPDATE SET ${updateSet}`;

      try {
        await this.db.query(sql, params);
        imported += batch.length;
      } catch (err: any) {
        failed += batch.length;
        logger.error(`[ImportTask ${taskId}] Upsert batch failed`, {
          table, offset: i, size: batch.length, error: err.message,
        });
      }

      const mem = taskProgress.get(taskId);
      if (mem) { mem.recordsImported = imported; mem.recordsFailed = failed; }
      if ((i / batchSize) % 10 === 0) {
        await this.db.query(
          `UPDATE import_tasks SET records_imported = $2, records_failed = $3, last_activity_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [taskId, imported, failed],
        ).catch(() => {});
      }
    }

    return { imported, failed };
  }

  private async replaceJsonSnapshot(
    table: string,
    mapping: Record<string, string>,
    records: any[],
  ): Promise<number> {
    const cols = Object.keys(mapping);
    const paths = Object.values(mapping);
    const client = await this.db.getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM ${table}`);
      const batchSize = 500;
      for (let i = 0; i < records.length; i += batchSize) {
        const params: any[] = [];
        const rowsSql = records.slice(i, i + batchSize).map(rec => {
          const placeholders = cols.map((_, c) => `$${params.length + c + 1}`).join(',');
          for (const p of paths) params.push(this.normalizeValue(getJsonPath(rec, p)));
          return `(${placeholders})`;
        });
        await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${rowsSql.join(',')}`, params);
      }
      await client.query('COMMIT');
      return records.length;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private getJsonPath(obj: any, path: string): any {
    return getJsonPath(obj, path);
  }

  private normalizeValue(v: any): any {
    if (v === undefined || v === null) return null;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  }

  // ---- JSON Array spread over several files of one CKAN dataset (LEXAI-2181) ----

  /**
   * source_config for this path:
   *   ckan_package      dataset id or slug on data.gov.ua; resources resolved via package_show per run
   *   ckan_api          optional package_show endpoint (default data.gov.ua)
   *   resource_pattern  regex on the resource file name (e.g. "^mvswantedpassport_v\\d+\\.json$")
   *   resource_format   optional CKAN resource `format` the resource must have (e.g. "API")
   *   latest_only       load only the most recently modified matching resource (dated snapshots)
   *   min_files         refuse when fewer resources match (default 1)
   *   format            json (array of objects, default) | csv | xlsx (first sheet, small files)
   *   csv_delimiter     CSV field delimiter (default ","; "\t" for the ДСА TSV)
   *   header_row        1-based non-blank row with the column names (csv/xlsx, default 1)
   *   skip_rows         rows to drop after the header (csv/xlsx, default 0)
   *   mapping           target column -> record field (csv/xlsx: header name; "" = whole record)
   *   transforms        target column -> VALUE_TRANSFORMS name (e.g. passport_series, iso_date)
   *   unique_key        [column]; duplicates across/within files collapse to one row
   *   dedup_order       column whose highest value wins among duplicates (then the later record)
   *   min_rows_ratio    refuse the swap if new rows < ratio × current rows (default 0.9)
   *   skip_unchanged    skip the run when no resource changed since the last successful load
   *
   * Every file is streamed into an UNLOGGED staging table; only when all of them loaded and
   * the guard passes is the target brought to the staging content in ONE transaction
   * (delete vanished keys + upsert changed rows), so readers never see a partial table and a
   * failed run leaves it exactly as it was.
   */
  private async runCkanMultiFileImport(taskId: number, source: SourceCatalog, signal: AbortSignal): Promise<void> {
    const config = source.source_config || {};
    const mapping = config.mapping as Record<string, string> | undefined;
    const transforms = (config.transforms || {}) as Record<string, string>;
    const uniqueKey = (config.unique_key as string[] | undefined) || [];
    const target = source.target_table;
    if (!mapping || !target) throw new Error('ckan_package source needs mapping and target_table');
    if (config.replace !== true) throw new Error('ckan_package sources are loaded with replace=true only');
    validateTransforms(transforms);
    const cols = Object.keys(mapping);
    for (const id of [target, ...cols, ...uniqueKey, ...(config.dedup_order ? [config.dedup_order] : [])]) {
      assertIdentifier(id);
    }
    for (const k of uniqueKey) if (!cols.includes(k)) throw new Error(`unique_key column ${k} is not mapped`);
    if (config.dedup_order && !cols.includes(config.dedup_order)) {
      throw new Error(`dedup_order column ${config.dedup_order} is not mapped`);
    }
    const format = String(config.format || 'json').toLowerCase() as CkanFormat;
    if (!CKAN_FORMATS.includes(format)) throw new Error(`unsupported format "${config.format}" for a ckan_package source`);
    const parseOpts: ResourceParseOptions = {
      format,
      delimiter: String(config.csv_delimiter ?? ','),
      headerRow: config.header_row != null ? Number(config.header_row) : undefined,
      skipRows: config.skip_rows != null ? Number(config.skip_rows) : undefined,
    };

    const pkgUrl = packageShowUrl(String(config.ckan_package), config.ckan_api);
    const pkg = await this.fetchJson(pkgUrl, null, signal);
    if (!pkg || pkg.success === false) throw new Error(`CKAN package_show failed: ${pkgUrl}`);
    let resources = selectCkanResources(pkg, String(config.resource_pattern || '\\.json$'), config.resource_format);
    if (config.latest_only) resources = latestCkanResource(resources);
    const minFiles = Number(config.min_files ?? 1);
    if (resources.length < minFiles) {
      throw new Error(`CKAN ${config.ckan_package}: ${resources.length} файлів за шаблоном ${config.resource_pattern} (очікується ≥ ${minFiles}); таблицю не змінено`);
    }
    await this.db.query('UPDATE import_tasks SET total_pages = $2 WHERE id = $1', [taskId, resources.length]);
    logger.info(`[ImportTask ${taskId}] ${resources.length} files in CKAN dataset ${config.ckan_package}`);

    if (config.skip_unchanged) {
      const last = await this.db.query(
        `SELECT max(started_at) AS at FROM import_tasks
          WHERE source_id = $1 AND id <> $2 AND status = 'completed' AND records_imported > 0`,
        [source.id, taskId],
      );
      const lastAt = last.rows[0]?.at;
      if (resourcesUnchangedSince(resources, lastAt)) {
        const msg = `джерело не змінювалось після останнього імпорту (${new Date(lastAt).toISOString()}), пропущено`;
        logger.info(`[ImportTask ${taskId}] ${msg}`);
        await this.db.query('UPDATE import_tasks SET last_error = $2 WHERE id = $1', [taskId, msg]);
        return;
      }
    }

    const staging = `${target}__staging_${taskId}`;
    const mem = taskProgress.get(taskId);
    try {
      await this.db.query(`DROP TABLE IF EXISTS ${staging}`);
      await this.db.query(`CREATE UNLOGGED TABLE ${staging} (LIKE ${target} INCLUDING DEFAULTS)`);
      await this.db.query(`ALTER TABLE ${staging} ADD COLUMN _src INT, ADD COLUMN _ord BIGSERIAL`);

      let rawRows = 0;
      let skipped = 0;
      for (let idx = 0; idx < resources.length; idx++) {
        const res = resources[idx];
        for (let attempt = 1; ; attempt++) {
          if (signal.aborted) throw new Error('Aborted');
          try {
            const r = await this.streamResourceIntoStaging(taskId, res, idx, staging, mapping, transforms, uniqueKey, parseOpts, signal);
            rawRows += r.loaded;
            skipped += r.skipped;
            break;
          } catch (err: any) {
            await this.db.query(`DELETE FROM ${staging} WHERE _src = $1`, [idx]);
            if (signal.aborted || attempt >= 3 || err.noRetry) throw new Error(`${res.name}: ${err.message}`);
            logger.warn(`[ImportTask ${taskId}] ${res.name} attempt ${attempt} failed: ${err.message}`);
            await this.sleep(5000 * attempt, signal);
          }
        }
        if (mem) { mem.pagesDone = idx + 1; mem.currentPage = idx + 1; mem.recordsImported = rawRows; mem.recordsFailed = skipped; }
        await this.db.query(
          `UPDATE import_tasks SET pages_done = $2, current_page = $2, records_imported = $3, records_failed = $4,
                  last_activity_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [taskId, idx + 1, rawRows, skipped],
        ).catch(() => {});
      }

      if (uniqueKey.length) await this.db.query(`CREATE INDEX ON ${staging} (${uniqueKey.join(', ')})`);
      await this.db.query(`ANALYZE ${staging}`);

      const { newRows, curRows, ...stats } = await this.swapFromStaging(
        target, staging, cols, uniqueKey, Number(config.min_rows_ratio ?? 0.9), config.dedup_order,
      );
      logger.info(`[ImportTask ${taskId}] ${target}: ${curRows} -> ${newRows} rows`, {
        raw: rawRows, skipped, deleted: stats.deleted, upserted: stats.upserted,
      });
      if (mem) { mem.recordsImported = newRows; mem.recordsFailed = skipped; }
    } finally {
      await this.db.query(`DROP TABLE IF EXISTS ${staging}`).catch(() => {});
    }
  }

  /** Stream one resource into the staging table in batches; returns rows loaded / skipped. */
  private async streamResourceIntoStaging(
    taskId: number, res: CkanResource, idx: number, staging: string,
    mapping: Record<string, string>, transforms: Record<string, string>, uniqueKey: string[],
    parseOpts: ResourceParseOptions, signal: AbortSignal,
  ): Promise<{ loaded: number; skipped: number }> {
    const cols = Object.keys(mapping);
    let batch: any[][] = [];
    let loaded = 0;
    let skipped = 0;
    // Mapped columns not yet seen in any record of this file. Judged over the whole file,
    // not the first batch: НАЗК records carry offenseId / courtCaseNumber only when there
    // is a court case, so a first chunk of decree-only records is not a renamed field.
    let unseen: Set<string> | null = null;

    const flush = async () => {
      if (batch.length === 0) return;
      const params: any[] = [];
      const rowsSql = batch.map(row => {
        const ph = row.map((_, c) => `$${params.length + c + 1}`);
        params.push(...row, idx);
        return `(${ph.join(',')},$${params.length})`;
      });
      await this.db.query(`INSERT INTO ${staging} (${cols.join(',')},_src) VALUES ${rowsSql.join(',')}`, params);
      loaded += batch.length;
      batch = [];
    };

    const take = async (records: any[]) => {
      if (records.length && (unseen === null || unseen.size > 0)) {
        const still = new Set(unresolvedMappingColumns(records, mapping));
        unseen = unseen === null ? still : new Set([...unseen].filter(c => still.has(c)));
      }
      for (const rec of records) {
        const row = cols.map(col => {
          const raw = getJsonPath(rec, mapping[col]);
          const t = transforms[col];
          return this.normalizeValue(t ? VALUE_TRANSFORMS[t](raw) : raw);
        });
        if (uniqueKey.some(k => row[cols.indexOf(k)] == null || row[cols.indexOf(k)] === '')) { skipped++; continue; }
        batch.push(row);
        if (batch.length >= 1000) await flush();
      }
    };

    const stream = await this.httpGetStream(res.url, signal, 60_000);
    if (parseOpts.format === 'xlsx') {
      const parts: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        size += (chunk as Buffer).length;
        if (size > XLSX_MAX_BYTES) {
          stream.destroy();
          throw Object.assign(new Error(`XLSX larger than ${XLSX_MAX_BYTES} bytes`), { noRetry: true });
        }
        parts.push(chunk as Buffer);
      }
      await take(await xlsxRecords(Buffer.concat(parts), parseOpts));
    } else {
      const parser = parseOpts.format === 'csv'
        ? new CsvStreamParser(parseOpts.delimiter, parseOpts)
        : new JsonArrayStreamParser();
      const decoder = new StringDecoder('utf8');
      for await (const chunk of stream) {
        await take(parser.push(decoder.write(chunk as Buffer)));
      }
      await take(parser.push(decoder.end()));
      await take(parser.end());
    }
    await flush();
    const missing: string[] = unseen ? [...(unseen as Set<string>)] : [];
    if (missing.length) {
      // The file itself is wrong (renamed header, changed layout): retrying cannot help.
      throw Object.assign(new Error(`no field for ${missing.join(', ')} in any source record`), { noRetry: true });
    }
    if (loaded === 0) throw new Error('file has no records');
    logger.info(`[ImportTask ${taskId}] ${res.name}: ${loaded} rows${skipped ? `, ${skipped} without key skipped` : ''}`);
    return { loaded, skipped };
  }

  /**
   * Bring `target` to exactly the staging content in one transaction. With a unique key:
   * duplicates collapse (highest dedup_order, then the later record wins), keys absent from
   * the source are deleted and only rows that actually changed are rewritten, so an unchanged
   * re-publication does not churn the indexes. Without a key: DELETE + INSERT.
   *
   * The replace guard (new rows vs current rows) is evaluated inside the transaction after
   * the per-table lock is held, so a swap that waited behind another one compares against
   * the table as that one left it, never against a stale count. A refusal rolls back.
   */
  private async swapFromStaging(
    target: string, staging: string, cols: string[], uniqueKey: string[], minRowsRatio: number, dedupOrder?: string,
  ): Promise<{ deleted: number; upserted: number; newRows: number; curRows: number }> {
    const hasImportedAt = (await this.db.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'imported_at'`,
      [target],
    )).rows.length > 0;
    const colList = cols.join(', ');

    return this.db.transaction(async (client) => {
      await client.query(`SET LOCAL statement_timeout = '60min'`);
      // Second line of defence next to the one-active-task rule in startImport: whatever
      // started them, two swaps into the same table never interleave.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('import_swap:' || $1))`, [target]);

      const keyExpr = uniqueKey.length ? `count(DISTINCT (${uniqueKey.join(', ')}))` : 'count(*)';
      const newRows = Number((await client.query(`SELECT ${keyExpr} AS n FROM ${staging}`)).rows[0].n);
      const curRows = Number((await client.query(`SELECT count(*) AS n FROM ${target}`)).rows[0].n);
      const refusal = replaceGuardError(newRows, curRows, minRowsRatio);
      if (refusal) throw new Error(`replace refused: ${refusal}; таблицю не змінено`);

      if (!uniqueKey.length) {
        const del = await client.query(`DELETE FROM ${target}`);
        const ins = await client.query(`INSERT INTO ${target} (${colList}) SELECT ${colList} FROM ${staging} ORDER BY _ord`);
        return { deleted: del.rowCount ?? 0, upserted: ins.rowCount ?? 0, newRows, curRows };
      }
      const keyList = uniqueKey.join(', ');
      const keyMatch = uniqueKey.map(k => `s.${k} = t.${k}`).join(' AND ');
      const del = await client.query(
        `DELETE FROM ${target} t WHERE NOT EXISTS (SELECT 1 FROM ${staging} s WHERE ${keyMatch})`,
      );
      const order = [keyList, ...(dedupOrder ? [`${dedupOrder} DESC NULLS LAST`] : []), '_ord DESC'].join(', ');
      const updCols = cols.filter(c => !uniqueKey.includes(c));
      const set = updCols.map(c => `${c} = EXCLUDED.${c}`).concat(hasImportedAt ? ['imported_at = NOW()'] : []).join(', ');
      const changed = updCols.length
        ? ` WHERE (${updCols.map(c => `${target}.${c}`).join(', ')}) IS DISTINCT FROM (${updCols.map(c => `EXCLUDED.${c}`).join(', ')})`
        : '';
      const conflict = set ? `DO UPDATE SET ${set}${changed}` : 'DO NOTHING';
      const ins = await client.query(
        `INSERT INTO ${target} (${colList})
         SELECT DISTINCT ON (${keyList}) ${colList} FROM ${staging} ORDER BY ${order}
         ON CONFLICT (${keyList}) ${conflict}`,
      );
      return { deleted: del.rowCount ?? 0, upserted: ins.rowCount ?? 0, newRows, curRows };
    });
  }

  /** GET with redirects; resolves to the 200 response stream (caller consumes it). */
  private httpGetStream(url: string, signal: AbortSignal, idleTimeoutMs: number, redirects = 0): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      if (redirects > 5) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https : http;
      const req = mod.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        timeout: idleTimeoutMs,
        headers: { 'Accept': 'application/json', 'User-Agent': 'SecondLayer-Legal-Platform/2.0' },
      }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          this.httpGetStream(next, signal, idleTimeoutMs, redirects + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        resolve(res);
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('Request timeout')));
      const onAbort = () => req.destroy(new Error('Aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', onAbort));
      req.end();
    });
  }

  // ---- File Download (ZIP/CSV/XML) ----

  private async runFileDownloadImport(taskId: number, source: SourceCatalog, signal: AbortSignal): Promise<void> {
    // File downloads use the existing sync-all-registries infrastructure
    // This is a placeholder — full ZIP extraction + XML parsing is handled by mcp_openreyestr scripts
    logger.info(`[ImportTask ${taskId}] File download import for ${source.name} — delegating to registry sync`);

    const mem = taskProgress.get(taskId);
    if (mem) {
      mem.pagesDone = 1;
      mem.lastError = 'file_download type requires running sync-all-registries. Use start_import for api_paginated or json_array sources.';
    }
  }

  // ========================= HTTP Fetcher =========================

  private async fetchJson(url: string, localAddress: string | null, signal: AbortSignal, timeoutMs: number = REQUEST_TIMEOUT): Promise<any> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (signal.aborted) return null;

      try {
        const data = await this.httpGet(url, localAddress, signal, timeoutMs);
        return JSON.parse(data.charCodeAt(0) === 0xfeff ? data.slice(1) : data);
      } catch (err: any) {
        if (signal.aborted) return null;
        if (err.statusCode === 429) {
          const wait = 5000 * Math.pow(2, attempt);
          logger.warn(`[Fetch] Rate limited via ${localAddress}, waiting ${wait}ms`);
          await this.sleep(wait, signal);
          continue;
        }
        if (err.statusCode && err.statusCode >= 500) {
          await this.sleep(2000 * (attempt + 1), signal);
          continue;
        }
        if (attempt < MAX_RETRIES - 1) {
          await this.sleep(2000 * (attempt + 1), signal);
          continue;
        }
        logger.error(`[Fetch] Failed ${url} via ${localAddress}: ${err.message}`);
        return null;
      }
    }
    return null;
  }

  private httpGet(url: string, localAddress: string | null, signal: AbortSignal, timeoutMs: number = REQUEST_TIMEOUT): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const mod = isHttps ? https : http;

      const opts: any = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'SecondLayer-Legal-Platform/2.0',
        },
      };

      if (localAddress) {
        opts.localAddress = localAddress;
      }

      const req = mod.request(opts, (res) => {
        // Follow redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this.httpGet(res.headers.location, localAddress, signal, timeoutMs).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode && res.statusCode !== 200) {
          const err: any = new Error(`HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

      // Abort support
      const onAbort = () => { req.destroy(); reject(new Error('Aborted')); };
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', onAbort));

      req.end();
    });
  }

  // ========================= Utils =========================

  private buildQueryParams(config: Record<string, any>): Record<string, string> {
    const params: Record<string, string> = {};
    if (config.obj_type) params.obj_type = String(config.obj_type);
    if (config.obj_state) params.obj_state = String(config.obj_state);
    return params;
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      const onAbort = () => { clearTimeout(timer); resolve(); };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
