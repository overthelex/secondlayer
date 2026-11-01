/**
 * ARMA seized assets — file → arma_assets load (LEXAI-2161).
 *
 * Every row seen in a run is upserted with all mapped fields and stamped with
 * the run's id (import_run_id). After a clean, complete pass the rows that
 * carry a different run id (stale, or mis-mapped by the pre-LEXAI-2161
 * importer) are deleted. No wall-clock comparison is involved.
 *
 * "Clean and complete" means: the closing "]" of the items array was read
 * (a download truncated at a line boundary is otherwise indistinguishable
 * from a smaller file), no line failed to parse, no batch failed, and the run
 * saw at least MIN_SEEN_RATIO of the rows the table had before.
 */
import * as fs from 'fs';
import * as readline from 'readline';
import crypto from 'crypto';
import type { Pool } from 'pg';
import { mapArmaItem, repairArmaLine } from './arma-mapping';

export const ARMA_BATCH_SIZE = 1000;
/** Refuse to delete stale rows if this run saw fewer than this share of the current rows. */
export const MIN_SEEN_RATIO = 0.8;

export interface ArmaReadState {
  parseErrors: number;
  /** The closing "]" of the items array was reached. */
  complete: boolean;
}

/**
 * Stream-parse the ARMA JSON file.
 * Structure: { results: [{ columns: [...], items: [ {item}, {item}, ... ] }] },
 * one item per line, lines prefixed or suffixed with ",".
 */
export async function* readArmaItems(filePath: string, state: ArmaReadState): AsyncGenerator<any> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  let foundItems = false;
  for await (const line of rl) {
    const trimmed = line.trim();

    if (!foundItems) {
      // `"items":` ends the header line; the "[" may be on the same or the next line.
      if (trimmed === '[' || (trimmed.includes('"items":') && trimmed.endsWith('['))) foundItems = true;
      continue;
    }

    if (trimmed.startsWith(']')) {
      state.complete = true;
      return;
    }

    let jsonStr = trimmed;
    if (jsonStr.startsWith(',')) jsonStr = jsonStr.slice(1);
    if (jsonStr.endsWith(',')) jsonStr = jsonStr.slice(0, -1);
    if (!jsonStr.startsWith('{')) continue;

    let item: any;
    try {
      item = JSON.parse(jsonStr);
    } catch {
      // ~3% of lines carry a decimal comma in actionincomesum (583526,51).
      try {
        item = JSON.parse(repairArmaLine(jsonStr));
      } catch {
        state.parseErrors++;
        if (state.parseErrors <= 5) console.error(`\n  Unparseable line: ${jsonStr.substring(0, 200)}`);
        continue;
      }
    }
    yield item;
  }
}

export const ARMA_UPSERT_SQL = `INSERT INTO arma_assets (asset_id, case_number, case_numbers, criminal_proceeding_number, case_date,
   court_name, judge_name, investigation_body, region, decision_type, asset_type, asset_description,
   asset_props, action_name, action_date, action_details, action_income_sum, status, arrest_date,
   transfer_date, manager, owner_name, owner_type, owner_edrpou, source_url, content_hash, import_run_id, updated_at)
 SELECT asset_id, case_number, case_numbers, criminal_proceeding_number, case_date,
   court_name, judge_name, investigation_body, region, decision_type, asset_type, asset_description,
   asset_props, action_name, action_date, action_details, action_income_sum, status, arrest_date,
   transfer_date, manager, NULL, NULL, NULL, source_url, content_hash, $2, now()
 FROM jsonb_to_recordset($1::jsonb) AS x(
   asset_id text, case_number text, case_numbers text[], criminal_proceeding_number text, case_date date,
   court_name text, judge_name text, investigation_body text, region text, decision_type text,
   asset_type text, asset_description text, asset_props text, action_name text, action_date date,
   action_details text, action_income_sum numeric, status text, arrest_date date, transfer_date date,
   manager text, source_url text, content_hash text)
 ON CONFLICT (content_hash) DO UPDATE SET
   asset_id = EXCLUDED.asset_id, case_number = EXCLUDED.case_number, case_numbers = EXCLUDED.case_numbers,
   criminal_proceeding_number = EXCLUDED.criminal_proceeding_number, case_date = EXCLUDED.case_date,
   court_name = EXCLUDED.court_name, judge_name = EXCLUDED.judge_name,
   investigation_body = EXCLUDED.investigation_body, region = EXCLUDED.region,
   decision_type = EXCLUDED.decision_type, asset_type = EXCLUDED.asset_type,
   asset_description = EXCLUDED.asset_description, asset_props = EXCLUDED.asset_props,
   action_name = EXCLUDED.action_name, action_date = EXCLUDED.action_date,
   action_details = EXCLUDED.action_details, action_income_sum = EXCLUDED.action_income_sum,
   status = EXCLUDED.status, arrest_date = EXCLUDED.arrest_date, transfer_date = EXCLUDED.transfer_date,
   manager = EXCLUDED.manager, owner_name = NULL, owner_type = NULL, owner_edrpou = NULL,
   source_url = EXCLUDED.source_url, import_run_id = EXCLUDED.import_run_id, updated_at = EXCLUDED.updated_at
 RETURNING (xmax = 0) AS is_insert`;

export const ARMA_DELETE_STALE_SQL = 'DELETE FROM arma_assets WHERE import_run_id IS DISTINCT FROM $1';

export interface ArmaImportStats {
  runId: string;
  items: number;
  inserted: number;
  updated: number;
  seen: number;
  before: number;
  parseErrors: number;
  batchErrors: number;
  complete: boolean;
  staleDeleted: number | null;
  staleKeptReason: string | null;
}

export function staleDeleteBlocker(s: Pick<ArmaImportStats, 'complete' | 'parseErrors' | 'batchErrors' | 'seen' | 'before'>): string | null {
  if (!s.complete) return 'source file has no closing "]" (truncated?)';
  if (s.parseErrors > 0) return `${s.parseErrors} unparseable lines`;
  if (s.batchErrors > 0) return `${s.batchErrors} failed batches`;
  if (s.seen === 0) return 'no rows seen';
  if (s.seen < s.before * MIN_SEEN_RATIO) return `saw ${s.seen} rows, below ${MIN_SEEN_RATIO} of ${s.before}`;
  return null;
}

export async function importArmaFile(
  pool: Pick<Pool, 'query'>,
  filePath: string,
  opts: { sourceUrl: string; runId?: string; batchSize?: number; onProgress?: (s: ArmaImportStats) => void },
): Promise<ArmaImportStats> {
  const runId = opts.runId || crypto.randomUUID();
  const batchSize = opts.batchSize || ARMA_BATCH_SIZE;
  const before = Number((await pool.query('SELECT COUNT(*) AS n FROM arma_assets')).rows[0].n);
  const state: ArmaReadState = { parseErrors: 0, complete: false };
  const stats: ArmaImportStats = {
    runId, items: 0, inserted: 0, updated: 0, seen: 0, before,
    parseErrors: 0, batchErrors: 0, complete: false, staleDeleted: null, staleKeptReason: null,
  };

  async function flush(records: any[]) {
    // One row per content hash: ON CONFLICT cannot touch the same row twice in a statement.
    const rows = new Map<string, any>();
    for (const record of records) {
      const hash = crypto.createHash('md5').update(JSON.stringify(record)).digest('hex');
      rows.set(hash, { ...mapArmaItem(record), content_hash: hash, source_url: opts.sourceUrl });
    }
    try {
      const res = await pool.query(ARMA_UPSERT_SQL, [JSON.stringify([...rows.values()]), runId]);
      for (const r of res.rows) {
        if (r.is_insert) stats.inserted++;
        else stats.updated++;
      }
    } catch (err) {
      stats.batchErrors++;
      console.error('\n  Batch failed:', (err as Error).message?.substring(0, 300));
    }
  }

  let batch: any[] = [];
  for await (const item of readArmaItems(filePath, state)) {
    batch.push(item);
    stats.items++;
    if (batch.length >= batchSize) {
      await flush(batch);
      batch = [];
      opts.onProgress?.(stats);
    }
  }
  if (batch.length > 0) await flush(batch);

  stats.parseErrors = state.parseErrors;
  stats.complete = state.complete;
  // Rows upserted in this run (a hash repeated across batches counts once in the table).
  stats.seen = Number((await pool.query('SELECT COUNT(*) AS n FROM arma_assets WHERE import_run_id = $1', [runId])).rows[0].n);

  stats.staleKeptReason = staleDeleteBlocker(stats);
  if (!stats.staleKeptReason) {
    const del = await pool.query(ARMA_DELETE_STALE_SQL, [runId]);
    stats.staleDeleted = del.rowCount ?? 0;
  }
  return stats;
}
