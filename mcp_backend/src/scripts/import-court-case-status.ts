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
 * Before the swap the snapshot is checked against the table and the last successful load
 * (court-case-status-guards.ts, LEXAI-2182): the 31.10.2026 ZIP shipped 26 of 30 files and
 * dropped whole courts while still passing the old «≥ 80% of rows» check. The swap is
 * refused when the snapshot has fewer files than the last load recorded in
 * opendata_court_case_status_loads (migration 234), when a court vanishes or loses more than
 * half its rows, or when the total falls below 80% of the table. Each successful load is
 * recorded in that table in the swap transaction.
 *
 * Usage:
 *   npx tsx src/scripts/import-court-case-status.ts --download [--dir /tmp/court_case_status]
 *   npx tsx src/scripts/import-court-case-status.ts <file.zip | dir-with-csv> [--dry-run] [--force]
 *
 * --download  resolve the newest ZIP via the CKAN API and save it under --dir first
 *             (default: court_case_status under os.tmpdir(), writable by the node user in
 *             the app container).
 * --dry-run   parse, report counts and what the swap guards would decide; nothing is
 *             written. The guards need read access to the database; without it they are
 *             reported as not evaluated.
 * --force     swap even when the guards refuse (and record the load as forced).
 */

import { Pool, type PoolClient } from 'pg';
import * as fs from 'fs';
import * as os from 'os';
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
import {
  evaluateSnapshotGuards,
  snapshotDateFromName,
  type LoadRecord,
} from './court-case-status-guards.js';

export const DSA_DATASET_ID = '0ad60ea9-b029-456d-abc0-8c77a99b205c';
const CKAN_PACKAGE_SHOW = `https://data.gov.ua/api/3/action/package_show?id=${DSA_DATASET_ID}`;
const DEFAULT_DIR = path.join(os.tmpdir(), 'court_case_status');
const TABLE = 'opendata_court_case_status';
const LOADS_TABLE = 'opendata_court_case_status_loads';
const BATCH_SIZE = 500;
/** pg_advisory_xact_lock key serialising guard checks + swap between importer runs. */
const SWAP_LOCK_KEY = 21820001;

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

/** The last successful load; throws when migration 234 has not created the table. */
async function readLastLoad(client: PoolClient): Promise<LoadRecord | null> {
  const exists = (await client.query(`SELECT to_regclass($1) AS t`, [LOADS_TABLE])).rows[0].t;
  if (!exists) throw new Error(`${LOADS_TABLE} is missing: apply migration 234_court_case_status_loads.sql first`);
  const res = await client.query(
    `SELECT file_count, total_rows, source_name, court_counts FROM ${LOADS_TABLE}
      ORDER BY loaded_at DESC, id DESC LIMIT 1`,
  );
  const r = res.rows[0];
  if (!r) return null;
  const courtCounts = new Map<string, number>(
    Object.entries((r.court_counts || {}) as Record<string, unknown>).map(([k, v]) => [k, Number(v)]),
  );
  return { fileCount: Number(r.file_count), totalRows: Number(r.total_rows), sourceName: r.source_name, courtCounts };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const dirIdx = args.indexOf('--dir');
  const dir = dirIdx >= 0 ? args[dirIdx + 1] : DEFAULT_DIR;
  let input = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--dir');
  if (args.includes('--download')) input = await download(dir);
  if (!input) {
    console.error('Usage: import-court-case-status.ts (--download | <file.zip|dir>) [--dir D] [--dry-run] [--force]');
    process.exit(2);
  }

  const maxYear = new Date().getFullYear() + 1;
  const stats: DateFixStats = { repaired: 0, dropped: 0 };
  const courts = new Map<string, number>();
  let rows = 0;
  let skipped = 0;
  let fileCount = 0;

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    user: process.env.POSTGRES_USER || 'secondlayer',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'secondlayer_prod',
    max: 2,
  });
  // A dry run only reads (current counts, last load) and still parses without a database.
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
  } catch (err) {
    if (!dryRun) { await pool.end(); throw err; }
    console.warn(`No database (${(err as any).code || (err as Error).message}): swap guards will not be evaluated`);
  }
  const stage = client && !dryRun ? client : null;
  const cols = TARGET_COLUMNS.join(', ');

  try {
    if (stage) {
      await stage.query(`CREATE TEMP TABLE stage_case_status (LIKE ${TABLE} INCLUDING DEFAULTS)`);
    }
    let batch: (string | null)[][] = [];
    const flush = async () => {
      if (!stage || !batch.length) { batch = []; return; }
      const params: (string | null)[] = [];
      const values = batch.map((r) => {
        const ph = r.map((v) => { params.push(v); return `$${params.length}`; });
        return `(${ph.join(',')})`;
      });
      await stage.query(`INSERT INTO stage_case_status (${cols}) VALUES ${values.join(',')}`, params);
      batch = [];
    };

    for (const { name, text } of sourceTexts(input)) {
      let index: number[] | null = null;
      let fileRows = 0;
      fileCount++;
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

    console.log(`Parsed ${rows} rows from ${fileCount} files (${skipped} without case number), ${courts.size} courts; ` +
      `dates repaired ${stats.repaired}, dropped ${stats.dropped}`);
    for (const c of ['Касаційний цивільний суд', 'Касаційний кримінальний суд', 'Касаційний господарський суд',
      'Касаційний адміністративний суд', 'Велика Палата Верховного Суду']) {
      console.log(`  ${c}: ${courts.get(c) || 0}`);
    }
    if (!client) return;

    // Guard reads, swap and load record run in one transaction under an advisory lock, so a
    // concurrent run cannot swap or record a load between our checks and our swap. A dry run
    // only reads and takes no lock.
    if (!dryRun) {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [SWAP_LOCK_KEY]);
    }
    const current = new Map<string, number>();
    const curRes = await client.query(`SELECT court_name, count(*) AS n FROM ${TABLE} GROUP BY court_name`);
    for (const r of curRes.rows) current.set(r.court_name || '', Number(r.n));
    const cur = [...current.values()].reduce((a, b) => a + b, 0);
    const lastLoad = await readLastLoad(client);
    if (!lastLoad) console.log(`No previous load recorded in ${LOADS_TABLE}: file-count check skipped`);
    else console.log(`Last load: ${lastLoad.sourceName || '?'} (${lastLoad.fileCount} files, ${lastLoad.totalRows} rows)`);
    const guard = evaluateSnapshotGuards({ current, next: courts, fileCount, lastLoad });
    if (!guard.ok) {
      const lines = guard.problems.map((p) => `  - ${p}`).join('\n');
      const msg = `Swap guards refuse this snapshot (${fileCount} files, ${rows} rows; table has ${cur}):\n${lines}`;
      if (dryRun) {
        console.log(`[dry-run] ${msg}\n[dry-run] a real run would ` +
          (force ? 'swap anyway (--force)' : `exit non-zero and leave ${TABLE} unchanged`));
        return;
      }
      if (!force) {
        throw new Error(`${msg}\nTable ${TABLE} left unchanged. Re-run with --force only after checking the source.`);
      }
      console.warn('!'.repeat(78));
      console.warn(`!!! --force: swapping in a snapshot the guards refuse:\n${lines}`);
      console.warn('!'.repeat(78));
    } else {
      console.log(`Swap guards passed (${fileCount} files, ${rows} rows; table has ${cur})`);
    }
    if (dryRun) { console.log(`[dry-run] ${TABLE} not changed`); return; }

    const source = path.basename(input);
    await client.query(`DELETE FROM ${TABLE}`);
    await client.query(`INSERT INTO ${TABLE} (${cols}) SELECT ${cols} FROM stage_case_status`);
    await client.query(
      `INSERT INTO ${LOADS_TABLE} (source_name, source_date, file_count, total_rows, court_counts, forced)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [source, snapshotDateFromName(source), fileCount, rows, JSON.stringify(Object.fromEntries(courts)), !guard.ok],
    );
    await client.query('COMMIT');
    console.log(`Replaced ${cur} rows with ${rows}; load recorded in ${LOADS_TABLE}. Run VACUUM ANALYZE ${TABLE}.`);
  } catch (err) {
    // Also ends the guard transaction on a refusal: the table and the load log stay as they were.
    if (stage) await stage.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client?.release();
    await pool.end();
  }
}

if (process.argv[1] && /import-court-case-status\.[jt]s$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
