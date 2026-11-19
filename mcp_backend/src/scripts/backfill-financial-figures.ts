/**
 * Backfill financial_figures (source 'dssu') from opendata_financial_statements.raw_xml.
 *
 * Reads Форми 1, 2, 1-м and 1-мс by id keyset, parses the cells with the shared parser
 * (api/tools/financial-statement-figures.ts) and upserts one row per company, year,
 * period and form; the later filing wins. The next batch is fetched while the current
 * one is parsed and written.
 *
 * Modes:
 *   (default)       full pass from the checkpoint (job 'dssu'), resumable: the last id
 *                   is committed with every batch, so a rerun continues where it stopped
 *   --incremental   rows added since the last run (id > checkpoint) and rows re-imported
 *                   since its start (imported_at, the importer's ON CONFLICT DO UPDATE);
 *                   until a first full pass has completed it resumes that pass instead
 *
 * The checkpoint moves only when a run starts at or below it; the completion marker
 * (last_run_started_at) only when a run covered every id without --from-id/--to-id,
 * and for a resumed pass it is the time the pass first started.
 *
 * Options:
 *   --batch N               rows per batch (default 2000)
 *   --statement-timeout T   per-statement timeout, e.g. 120s (default 300s)
 *   --from-id N             start after this id (overrides the checkpoint; also bounds --incremental)
 *   --to-id N               stop at this id (default: max id at start; also bounds --incremental)
 *   --reset                 forget the checkpoint and start from the first id
 *   --dry-run               parse and count, write nothing
 *
 * Usage (in the backend image):
 *   node dist/scripts/backfill-financial-figures.js [--incremental] [options]
 */

import { Pool, PoolClient } from 'pg';
import { figureRowFromFiling, FinancialFigureRow } from '../api/tools/financial-statement-figures.js';
import { statementTimeoutLiteral, upsertFigureRows } from '../services/financial-figures-store.js';

const JOB = 'dssu';
const FORMS = ['001', '002', '100', '110'];

interface Options {
  incremental: boolean;
  batch: number;
  statementTimeout: string;
  fromId: number | null;
  toId: number | null;
  reset: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const o: Options = { incremental: false, batch: 2000, statementTimeout: '300s', fromId: null, toId: null, reset: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--incremental') o.incremental = true;
    else if (a === '--batch') o.batch = Math.max(1, Math.min(20000, parseInt(next(), 10) || 2000));
    else if (a === '--statement-timeout') o.statementTimeout = statementTimeoutLiteral(next());
    else if (a === '--from-id') o.fromId = parseInt(next(), 10);
    else if (a === '--to-id') o.toId = parseInt(next(), 10);
    else if (a === '--reset') o.reset = true;
    else if (a === '--dry-run') o.dryRun = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

function makePool(): Pool {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'secondlayer',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'secondlayer_local',
    max: 3,
    application_name: 'backfill-financial-figures',
  });
}

async function connect(pool: Pool, timeout: string): Promise<PoolClient> {
  const c = await pool.connect();
  await c.query(`SET statement_timeout = '${timeout}'`);
  return c;
}

const SELECT_COLS = 'id, tin, c_doc_sub, period_year, period_month, raw_xml';

interface Stats { read: number; parsed: number; written: number; skipped: number; started: number }

function report(s: Stats, lastId: number, toId: number, fromId: number): void {
  const sec = (Date.now() - s.started) / 1000;
  const rate = s.read / Math.max(sec, 0.001);
  const left = toId > lastId && lastId > fromId ? ((toId - lastId) / (lastId - fromId)) * sec : 0;
  console.log(`  id ${lastId}/${toId}: read ${s.read}, parsed ${s.parsed}, written ${s.written}, skipped ${s.skipped}; `
    + `${rate.toFixed(0)} rows/s, ${sec.toFixed(0)} s elapsed${left ? `, ~${(left / 60).toFixed(0)} min left` : ''}`);
}

function parseBatch(rows: any[], stats: Stats): FinancialFigureRow[] {
  const out: FinancialFigureRow[] = [];
  for (const r of rows) {
    stats.read++;
    let fig: FinancialFigureRow | null = null;
    try { fig = figureRowFromFiling(r); } catch { fig = null; }
    if (fig) { out.push(fig); stats.parsed++; } else stats.skipped++;
  }
  return out;
}

/** Whether this run may move the checkpoint (it covers the ids right after it). */
let moveCheckpoint = true;

async function writeBatch(writer: PoolClient, figs: FinancialFigureRow[], lastId: number, dryRun: boolean, stats: Stats): Promise<void> {
  if (dryRun) return;
  await writer.query('BEGIN');
  try {
    const n = await upsertFigureRows(writer, figs);
    stats.written += n;
    await writer.query(
      `INSERT INTO financial_figures_progress (job, last_id, rows_written, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (job) DO UPDATE SET
         last_id = CASE WHEN $4 THEN GREATEST(financial_figures_progress.last_id, EXCLUDED.last_id) ELSE financial_figures_progress.last_id END,
         rows_written = financial_figures_progress.rows_written + $3, updated_at = NOW()`,
      [JOB, moveCheckpoint ? lastId : 0, n, moveCheckpoint],
    );
    await writer.query('COMMIT');
  } catch (e) {
    await writer.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

async function fullPass(pool: Pool, o: Options, fromId: number, toId: number, stats: Stats): Promise<number> {
  const reader = await connect(pool, o.statementTimeout);
  const writer = await connect(pool, o.statementTimeout);
  const fetch = (after: number) => reader.query(
    `SELECT ${SELECT_COLS} FROM opendata_financial_statements
     WHERE id > $1 AND id <= $2 AND c_doc_sub = ANY($3) ORDER BY id LIMIT $4`,
    [after, toId, FORMS, o.batch],
  );
  let lastId = fromId;
  let batches = 0;
  try {
    let pending = fetch(lastId);
    for (;;) {
      const res = await pending;
      if (!res.rows.length) break;
      const batchLast = Number(res.rows[res.rows.length - 1].id);
      // Prefetch the next batch on the reader while this one is parsed and written.
      pending = fetch(batchLast);
      pending.catch(() => undefined); // surfaced by the next await; no unhandled rejection meanwhile
      const figs = parseBatch(res.rows, stats);
      await writeBatch(writer, figs, batchLast, o.dryRun, stats);
      lastId = batchLast;
      if (++batches % 25 === 0) report(stats, lastId, toId, fromId);
    }
  } finally {
    reader.release();
    writer.release();
  }
  report(stats, lastId, toId, fromId);
  return lastId;
}

/**
 * Ids for an incremental run: above the checkpoint, or re-imported since the last
 * completed run; both within --from-id / --to-id when given.
 */
async function incrementalIds(pool: Pool, o: Options, lastId: number, since: Date | null): Promise<number[]> {
  const c = await connect(pool, o.statementTimeout);
  try {
    const res = await c.query(
      `SELECT id FROM opendata_financial_statements
       WHERE c_doc_sub = ANY($1) AND (id > $2 OR ($3::timestamptz IS NOT NULL AND imported_at > $3))
         AND id > $4 AND id <= $5
       ORDER BY id`,
      [FORMS, lastId, since, o.fromId ?? 0, o.toId ?? Number.MAX_SAFE_INTEGER],
    );
    return res.rows.map((r) => Number(r.id));
  } finally {
    c.release();
  }
}

async function processIds(pool: Pool, o: Options, ids: number[], stats: Stats): Promise<void> {
  const reader = await connect(pool, o.statementTimeout);
  const writer = await connect(pool, o.statementTimeout);
  try {
    for (let i = 0; i < ids.length; i += o.batch) {
      const chunk = ids.slice(i, i + o.batch);
      const res = await reader.query(`SELECT ${SELECT_COLS} FROM opendata_financial_statements WHERE id = ANY($1) ORDER BY id`, [chunk]);
      const figs = parseBatch(res.rows, stats);
      await writeBatch(writer, figs, chunk[chunk.length - 1], o.dryRun, stats);
    }
  } finally {
    reader.release();
    writer.release();
  }
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const pool = makePool();
  const stats: Stats = { read: 0, parsed: 0, written: 0, skipped: 0, started: Date.now() };
  try {
    const meta = await pool.query(
      `SELECT NOW() AS now, (SELECT COALESCE(MAX(id), 0) FROM opendata_financial_statements) AS max_id,
              (SELECT row_to_json(p) FROM financial_figures_progress p WHERE job = $1) AS progress`,
      [JOB],
    );
    const runStarted: Date = meta.rows[0].now;
    const maxId = Number(meta.rows[0].max_id);
    const progress = o.reset ? null : meta.rows[0].progress;
    if (o.reset && !o.dryRun) await pool.query('DELETE FROM financial_figures_progress WHERE job = $1', [JOB]);

    const checkpoint = progress ? Number(progress.last_id) : 0;
    // last_run_started_at is set only by a completed run, so a checkpoint without it is
    // an interrupted first pass: it is resumed, not trusted for an incremental run.
    const completed = !!progress?.last_run_started_at;
    const bounded = o.fromId !== null || (o.toId !== null && o.toId < maxId);
    // Only a run that starts at or below the checkpoint moves it, so no id range is skipped.
    moveCheckpoint = o.fromId === null || o.fromId <= checkpoint;
    let completesPass = false;
    let passStartedAt: Date | null = null;

    if (o.incremental && completed) {
      const since = new Date(progress.last_run_started_at);
      const ids = await incrementalIds(pool, o, checkpoint, since);
      console.log(`Incremental: ${ids.length} filings after id ${checkpoint} or re-imported since ${since.toISOString()}`
        + (bounded ? `, ids ${(o.fromId ?? 0) + 1}..${o.toId ?? 'max'}` : ''));
      await processIds(pool, o, ids, stats);
      completesPass = !bounded;
      passStartedAt = runStarted;
    } else {
      if (o.incremental) console.log(progress ? 'Incremental: the first full pass has not completed, resuming it' : 'Incremental: no checkpoint yet, running a full pass');
      const fromId = o.fromId ?? checkpoint;
      const toId = o.toId ?? maxId;
      // A pass that covers the table from its start (fresh, or resuming one) records when
      // it began; that time, not the resume time, is what the next incremental run uses.
      if (!o.dryRun && !completed && fromId <= checkpoint) {
        const r = await pool.query(
          `INSERT INTO financial_figures_progress (job, last_id, pass_started_at, updated_at) VALUES ($1, 0, $2, NOW())
           ON CONFLICT (job) DO UPDATE SET pass_started_at = COALESCE(financial_figures_progress.pass_started_at, EXCLUDED.pass_started_at)
           RETURNING pass_started_at`,
          [JOB, runStarted],
        );
        passStartedAt = r.rows[0].pass_started_at;
      }
      console.log(`Full pass: ids ${fromId + 1}..${toId}, batch ${o.batch}, statement_timeout ${o.statementTimeout}${o.dryRun ? ', dry run' : ''}`);
      await fullPass(pool, o, fromId, toId, stats);
      completesPass = passStartedAt !== null && !bounded;
    }

    // Completion marker: the next incremental run re-reads rows imported after the start of
    // the pass that just completed. A bounded or partial run leaves it as it was.
    if (!o.dryRun && completesPass) {
      await pool.query(
        `UPDATE financial_figures_progress SET last_id = GREATEST(last_id, $2), last_run_started_at = $3,
           pass_started_at = NULL, updated_at = NOW() WHERE job = $1`,
        [JOB, maxId, passStartedAt],
      );
    }
    const sec = (Date.now() - stats.started) / 1000;
    console.log(`Done: read ${stats.read}, parsed ${stats.parsed}, written ${stats.written}, skipped ${stats.skipped} in ${sec.toFixed(1)} s`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal:', err?.message ?? err);
  process.exit(1);
});
