/**
 * Reload opendata_court_case_status from the ДСА dataset «Інформація щодо стану розгляду
 * справ» on data.gov.ua (LEXAI-2173).
 *
 * The catalog entry the weekly opendata-sync job used (dataset af2a2498-…) no longer
 * exists on data.gov.ua (CKAN 404, download 403), so every run since 19.04.2026 failed
 * with «Cannot download JSON», and the table kept the one-off load of 22.03.2026. The
 * data now lives in dataset 0ad60ea9-b029-456d-abc0-8c77a99b205c as a daily ZIP
 * («stan-rozglyadu-sprav-vid-DD-MM-YYYY.zip», ~0.9 GB, ~30 quoted TSV files, ~1.46M rows).
 * It is a cumulative snapshot without a stable row key, so it is reloaded whole: rows are
 * staged first, then the table is swapped with DELETE + INSERT in one transaction, so the
 * search tool keeps reading the old rows until COMMIT.
 *
 * Dates are normalised on the way in (court-case-status-dates.ts): a doubled year
 * («01.12.2323») is repaired, other impossible years are stored as NULL.
 *
 * Usage:
 *   npx tsx src/scripts/import-court-case-status.ts --download [--dir /data/opendata/court_case_status]
 *   npx tsx src/scripts/import-court-case-status.ts <file.zip | dir-with-csv> [--dry-run]
 *
 * --download  resolve the newest ZIP via the CKAN API and save it under --dir first.
 * --dry-run   parse and report counts without touching the database.
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import AdmZip from 'adm-zip';
import {
  columnIndex,
  parseQuotedTsv,
  pickLatestZip,
  toTargetRow,
  TARGET_COLUMNS,
  type DateFixStats,
} from './court-case-status-dates.js';

export const DSA_DATASET_ID = '0ad60ea9-b029-456d-abc0-8c77a99b205c';
const CKAN_PACKAGE_SHOW = `https://data.gov.ua/api/3/action/package_show?id=${DSA_DATASET_ID}`;
const DEFAULT_DIR = '/data/opendata/court_case_status';
const TABLE = 'opendata_court_case_status';
const BATCH_SIZE = 500;
/** Refuse to swap in a snapshot much smaller than the table: a truncated download. */
const MIN_SNAPSHOT_RATIO = 0.8;

async function download(dir: string): Promise<string> {
  const res = await fetch(CKAN_PACKAGE_SHOW);
  if (!res.ok) throw new Error(`CKAN package_show ${res.status}`);
  const body: any = await res.json();
  const latest = pickLatestZip(body?.result?.resources || []);
  if (!latest) throw new Error(`dataset ${DSA_DATASET_ID} has no ZIP resource`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, path.basename(new URL(latest.url).pathname));
  console.log(`Downloading ${latest.url} -> ${file}`);
  const dl = await fetch(latest.url);
  if (!dl.ok || !dl.body) throw new Error(`download ${dl.status}`);
  await pipeline(Readable.fromWeb(dl.body as any), fs.createWriteStream(file));
  console.log(`Saved ${(fs.statSync(file).size / 1e6).toFixed(0)} MB`);
  return file;
}

/** Yield the text of every CSV in a ZIP or a directory, one file at a time. */
function* sourceTexts(input: string): Generator<{ name: string; text: string }> {
  if (fs.statSync(input).isDirectory()) {
    for (const f of fs.readdirSync(input).filter((x) => /\.csv$/i.test(x)).sort()) {
      yield { name: f, text: fs.readFileSync(path.join(input, f), 'utf8') };
    }
    return;
  }
  const zip = new AdmZip(input);
  const entries = zip.getEntries().filter((e) => !e.isDirectory && /\.csv$/i.test(e.entryName));
  entries.sort((a, b) => a.entryName.localeCompare(b.entryName, 'en', { numeric: true }));
  for (const e of entries) yield { name: e.entryName, text: e.getData().toString('utf8') };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const dirIdx = args.indexOf('--dir');
  const dir = dirIdx >= 0 ? args[dirIdx + 1] : DEFAULT_DIR;
  let input = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--dir');
  if (args.includes('--download')) input = await download(dir);
  if (!input) {
    console.error('Usage: import-court-case-status.ts (--download | <file.zip|dir>) [--dry-run]');
    process.exit(2);
  }

  const maxYear = new Date().getFullYear() + 1;
  const stats: DateFixStats = { repaired: 0, dropped: 0 };
  const courts = new Map<string, number>();
  let rows = 0;
  let skipped = 0;

  const pool = dryRun ? null : new Pool({
    connectionString: process.env.DATABASE_URL,
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    user: process.env.POSTGRES_USER || 'secondlayer',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'secondlayer_prod',
    max: 2,
  });
  const client = pool ? await pool.connect() : null;
  const cols = TARGET_COLUMNS.join(', ');

  try {
    if (client) {
      await client.query(`CREATE TEMP TABLE stage_case_status (LIKE ${TABLE} INCLUDING DEFAULTS)`);
    }
    let batch: (string | null)[][] = [];
    const flush = async () => {
      if (!client || !batch.length) { batch = []; return; }
      const params: (string | null)[] = [];
      const values = batch.map((r) => {
        const ph = r.map((v) => { params.push(v); return `$${params.length}`; });
        return `(${ph.join(',')})`;
      });
      await client.query(`INSERT INTO stage_case_status (${cols}) VALUES ${values.join(',')}`, params);
      batch = [];
    };

    for (const { name, text } of sourceTexts(input)) {
      let index: number[] | null = null;
      let fileRows = 0;
      for (const rec of parseQuotedTsv(text)) {
        if (!index) { index = columnIndex(rec); continue; }
        const row = toTargetRow(index, rec, maxYear, stats);
        if (!row) { skipped++; continue; }
        batch.push(row);
        rows++; fileRows++;
        courts.set(row[0] || '', (courts.get(row[0] || '') || 0) + 1);
        if (batch.length >= BATCH_SIZE) await flush();
      }
      await flush();
      console.log(`${name}: ${fileRows} rows`);
    }

    console.log(`Parsed ${rows} rows (${skipped} without case number), ${courts.size} courts; ` +
      `dates repaired ${stats.repaired}, dropped ${stats.dropped}`);
    for (const c of ['Касаційний цивільний суд', 'Касаційний кримінальний суд', 'Касаційний господарський суд',
      'Касаційний адміністративний суд', 'Велика Палата Верховного Суду']) {
      console.log(`  ${c}: ${courts.get(c) || 0}`);
    }
    if (!client) return;

    const cur = Number((await client.query(`SELECT count(*) AS n FROM ${TABLE}`)).rows[0].n);
    if (rows < cur * MIN_SNAPSHOT_RATIO) {
      throw new Error(`snapshot has ${rows} rows, table has ${cur}: refusing to replace`);
    }
    await client.query('BEGIN');
    await client.query(`DELETE FROM ${TABLE}`);
    await client.query(`INSERT INTO ${TABLE} (${cols}) SELECT ${cols} FROM stage_case_status`);
    await client.query('COMMIT');
    console.log(`Replaced ${cur} rows with ${rows}. Run VACUUM ANALYZE ${TABLE}.`);
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client?.release();
    await pool?.end();
  }
}

if (process.argv[1] && /import-court-case-status\.[jt]s$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
