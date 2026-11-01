/**
 * ARMA Seized Assets Import
 * Downloads JSON from data.gov.ua and imports into PostgreSQL.
 * Uses streaming parser for large files (600+ MB).
 *
 * Usage: node dist/scripts/import-arma.js [--skip-download]
 *
 * JSON structure: { results: [{ columns: [...], items: [...] }] }
 * Field mapping: services/arma-mapping.ts (LEXAI-2161). Every row seen in this
 * run is upserted with all mapped fields; after a clean full pass, rows that
 * were not seen (stale or mis-mapped by an older importer) are deleted.
 */
import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import https from 'https';
import http from 'http';
import crypto from 'crypto';
import { mapArmaItem, repairArmaLine } from '../services/arma-mapping';

const ARMA_URL = 'https://data.gov.ua/dataset/d6cc6909-4098-47bc-a2e4-96182f446982/resource/02435739-9481-40ca-b40f-6379b6ed5949/download/edra_opendata.json';
const DATA_DIR = process.env.NAIS_DATA_DIR || path.join(__dirname, '../../data/nais');
const BATCH_SIZE = 1000;
const LOCK_KEY = 21610001; // pg advisory lock: one ARMA import at a time
/** Refuse to delete stale rows if this run saw fewer than this share of the current rows. */
const MIN_SEEN_RATIO = 0.8;

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (url: string, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const proto = url.startsWith('https') ? https : http;
      proto.get(url, { timeout: 10 * 60 * 1000 }, (response: any) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          const loc = response.headers.location.startsWith('http')
            ? response.headers.location
            : new URL(response.headers.location, url).href;
          return follow(loc, redirects + 1);
        }
        if (response.statusCode !== 200) {
          return reject(new Error(`HTTP ${response.statusCode}`));
        }
        const file = fs.createWriteStream(dest);
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes % (5 * 1024 * 1024) < chunk.length) {
            process.stdout.write(`\r  Downloaded: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
          }
        });
        response.pipe(file);
        file.on('finish', () => { file.close(); console.log(`\n  Total: ${(bytes / 1024 / 1024).toFixed(1)} MB`); resolve(); });
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

/**
 * Stream-parse the ARMA JSON file.
 * Structure: { results: [{ columns: [...], items: [ {item}, {item}, ... ] }] }
 *
 * Each item is on its own line (or close to it).
 * Strategy: skip to "items": line, then parse each {...} object between commas.
 */
export const parseStats = { parseErrors: 0 };

async function* readItemsFromFile(filePath: string): AsyncGenerator<any> {
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  let foundItems = false;

  for await (const line of rl) {
    const trimmed = line.trim();

    if (!foundItems) {
      // "items": may be on a line, with [ on the next line
      if (trimmed.includes('"items":') || trimmed === '[') {
        if (trimmed === '[' || trimmed.endsWith('[')) {
          foundItems = true;
        }
        // If "items": is on this line but [ is not, next line with [ will trigger
      }
      continue;
    }

    // End of items array
    if (trimmed === ']' || trimmed.startsWith(']}')) return;

    // Each line is a JSON object, possibly with leading/trailing comma
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
        parseStats.parseErrors++;
        if (parseStats.parseErrors <= 5) console.error(`\n  Unparseable line: ${jsonStr.substring(0, 200)}`);
        continue;
      }
    }
    yield item;
  }
}

async function importArma() {
  const skipDownload = process.argv.includes('--skip-download');
  const jsonPath = path.join(DATA_DIR, 'arma_assets.json');

  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!skipDownload) {
    console.log('Downloading ARMA seized assets from data.gov.ua...');
    await downloadFile(ARMA_URL, jsonPath);
  }

  if (!fs.existsSync(jsonPath)) {
    console.error(`File not found: ${jsonPath}`);
    process.exit(1);
  }

  const fileSizeMB = (fs.statSync(jsonPath).size / 1024 / 1024).toFixed(1);
  console.log(`Parsing ${fileSizeMB} MB JSON (streaming)...`);

  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435'),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'openreyestr',
    max: 2,
  });

  const lockClient = await pool.connect();
  const lock = await lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
  if (!lock.rows[0]?.ok) {
    console.error('Another ARMA import holds the lock — exiting');
    lockClient.release();
    await pool.end();
    process.exit(1);
  }

  const runStart: Date = (await pool.query('SELECT clock_timestamp() AS t')).rows[0].t;
  const before = Number((await pool.query('SELECT COUNT(*) AS n FROM arma_assets')).rows[0].n);

  let imported = 0;
  let updated = 0;
  let batchErrors = 0;
  let total = 0;
  let batch: any[] = [];

  async function flushBatch(records: any[]) {
    // One row per content hash: ON CONFLICT cannot touch the same row twice in a statement.
    const rows = new Map<string, any>();
    for (const record of records) {
      const hash = crypto.createHash('md5').update(JSON.stringify(record)).digest('hex');
      rows.set(hash, { ...mapArmaItem(record), content_hash: hash, source_url: ARMA_URL });
    }
    try {
      const result = await pool.query(
        `INSERT INTO arma_assets (asset_id, case_number, case_numbers, criminal_proceeding_number, case_date,
           court_name, judge_name, investigation_body, region, decision_type, asset_type, asset_description,
           asset_props, action_name, action_date, action_details, action_income_sum, status, arrest_date,
           transfer_date, manager, owner_name, owner_type, owner_edrpou, source_url, content_hash, updated_at)
         SELECT asset_id, case_number, case_numbers, criminal_proceeding_number, case_date,
           court_name, judge_name, investigation_body, region, decision_type, asset_type, asset_description,
           asset_props, action_name, action_date, action_details, action_income_sum, status, arrest_date,
           transfer_date, manager, NULL, NULL, NULL, source_url, content_hash, clock_timestamp()
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
           source_url = EXCLUDED.source_url, updated_at = EXCLUDED.updated_at
         RETURNING (xmax = 0) AS is_insert`,
        [JSON.stringify([...rows.values()])]
      );
      for (const r of result.rows) {
        if (r.is_insert) imported++;
        else updated++;
      }
    } catch (err) {
      batchErrors++;
      console.error('\n  Batch failed:', (err as Error).message?.substring(0, 300));
    }
  }

  for await (const item of readItemsFromFile(jsonPath)) {
    batch.push(item);
    total++;

    if (batch.length >= BATCH_SIZE) {
      await flushBatch(batch);
      batch = [];
      process.stdout.write(`\r  Records: ${total} | New: ${imported} | Updated: ${updated} | Batch errors: ${batchErrors}`);
    }
  }

  if (batch.length > 0) {
    await flushBatch(batch);
  }

  const seen = imported + updated;
  console.log(`\n\nDone: ${imported} new, ${updated} updated, ${seen} distinct rows, ${total} items parsed, ` +
    `${parseStats.parseErrors} unparseable lines, ${batchErrors} failed batches (rows before: ${before})`);

  if (parseStats.parseErrors === 0 && batchErrors === 0 && seen >= before * MIN_SEEN_RATIO && seen > 0) {
    const del = await pool.query('DELETE FROM arma_assets WHERE updated_at < $1', [runStart]);
    console.log(`Deleted ${del.rowCount} rows not present in the current source file`);
  } else {
    console.warn('Stale rows kept: run was not clean or saw too few rows');
  }

  const count = await pool.query('SELECT COUNT(*) FROM arma_assets');
  console.log(`Total in database: ${count.rows[0].count}`);

  await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  lockClient.release();
  await pool.end();
  if (parseStats.parseErrors > 0 || batchErrors > 0) process.exit(2);
}

importArma().catch(e => { console.error(e); process.exit(1); });
