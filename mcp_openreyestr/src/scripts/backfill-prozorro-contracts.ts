/**
 * ProZorro contracts backfill (LEXAI-2227)
 *
 * The incremental importer now stores contracts with the winning supplier, but
 * the 8M tenders already in prozorro_tenders were loaded without them. The
 * list endpoint cannot help: since ≈2025 its contract stub has no supplier,
 * and opt_fields cannot return awards, so every awarded tender needs one
 * GET /tenders/<id>.
 *
 * Walks prozorro_tenders by id (keyset) with an optional CPV prefix and
 * date_created floor, re-fetches each tender, and upserts both the tender row
 * and its contracts. The cursor (last id) is committed with each batch in
 * prozorro_sync_state under a key derived from the filter, so separate
 * filters (CPV 45 first, then everything) resume independently.
 *
 * Usage (inside the openreyestr container):
 *   node dist/scripts/backfill-prozorro-contracts.js --cpv=45 --since=2021-01-01
 *   node dist/scripts/backfill-prozorro-contracts.js --max-minutes=600
 *   node dist/scripts/backfill-prozorro-contracts.js --cpv=45 --limit=200 --dry-run
 *
 * Env: PROZORRO_CONCURRENCY (default 30), PROZORRO_DELAY_MS, POSTGRES_*.
 */
import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { buildContractsUpsert, buildUpsert, CONTRACTS_DDL } from './lib/prozorro-feed';
import { createProzorroClient, log } from './lib/prozorro-http';

const CONCURRENCY = Math.max(1, parseInt(process.env.PROZORRO_CONCURRENCY || '30', 10));
const DELAY_MS = Math.max(0, parseInt(process.env.PROZORRO_DELAY_MS || '0', 10));
const BATCH = 500;
const LOCK_KEY = 2227_0001;
// Statuses that can carry a contract. Unsuccessful/cancelled tenders may still
// have one on a lot, but are skipped to keep the first pass to real winners.
const STATUSES = ['complete', 'active.awarded', 'active.qualification'];

interface Args { cpv: string | null; since: string | null; limit: number; maxMinutes: number; dryRun: boolean; reset: boolean }

export function parseBackfillArgs(argv: string[]): Args {
  const a: Args = { cpv: null, since: null, limit: Infinity, maxMinutes: Infinity, dryRun: false, reset: false };
  for (const arg of argv) {
    const i = arg.indexOf('=');
    const k = i < 0 ? arg : arg.slice(0, i);
    const v = i < 0 ? '' : arg.slice(i + 1);
    switch (k) {
      case '--cpv': if (!/^\d{1,8}$/.test(v)) throw new Error(`--cpv expects digits, got "${v}"`); a.cpv = v; break;
      case '--since': if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--since expects YYYY-MM-DD, got "${v}"`); a.since = v; break;
      case '--limit': a.limit = parseInt(v, 10) > 0 ? parseInt(v, 10) : Infinity; break;
      case '--max-minutes': a.maxMinutes = parseFloat(v) > 0 ? parseFloat(v) : Infinity; break;
      case '--dry-run': a.dryRun = true; break;
      case '--reset': a.reset = true; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return a;
}

export function cursorKey(a: Pick<Args, 'cpv' | 'since'>): string {
  return `contracts_backfill:cpv=${a.cpv ?? '*'}:since=${a.since ?? '*'}`;
}

let stopRequested = false;

async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2));
  const deadline = Number.isFinite(args.maxMinutes) ? Date.now() + args.maxMinutes * 60_000 : Infinity;
  const key = cursorKey(args);
  const client = createProzorroClient(CONCURRENCY, DELAY_MS);

  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435', 10),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'openreyestr',
    max: 3,
  });

  const lockClient = await pool.connect();
  if (!(await lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY])).rows[0].ok) {
    log('Another contracts backfill holds the lock; exiting.');
    lockClient.release();
    await pool.end();
    return;
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (stopRequested) process.exit(130);
      stopRequested = true;
      log(`${sig}: finishing the current batch, then stopping (send again to abort)`);
    });
  }

  if (!args.dryRun) await pool.query(CONTRACTS_DDL);
  let lastId = 0;
  if (!args.reset) {
    const st = await pool.query(`SELECT next_offset FROM prozorro_sync_state WHERE feed = $1`, [key]);
    if (st.rows[0]) lastId = parseInt(st.rows[0].next_offset, 10) || 0;
  }

  const where: string[] = ['id > $1', 'status = ANY($2)'];
  const params: unknown[] = [0, STATUSES];
  if (args.cpv) { params.push(`${args.cpv}%`); where.push(`cpv_code LIKE $${params.length}`); }
  if (args.since) { params.push(args.since); where.push(`date_created >= $${params.length}`); }
  params.push(BATCH);
  const selectSql = `SELECT id, tender_id FROM prozorro_tenders WHERE ${where.join(' AND ')} ORDER BY id LIMIT $${params.length}`;

  log(`Contracts backfill ${key}: from id>${lastId}, concurrency=${CONCURRENCY}${args.dryRun ? ' DRY RUN' : ''}`);
  const t0 = Date.now();
  let seen = 0, withContracts = 0, contracts = 0, withSupplier = 0, gone = 0;
  let reason = 'done (no more tenders)';

  try {
    for (;;) {
      if (stopRequested) { reason = 'signal'; break; }
      if (Date.now() > deadline) { reason = `--max-minutes=${args.maxMinutes} reached`; break; }
      if (seen >= args.limit) { reason = `--limit=${args.limit} reached`; break; }

      params[0] = lastId;
      const rows: { id: number; tender_id: string }[] = (await pool.query(selectSql, params)).rows;
      if (rows.length === 0) break;
      const batch = Number.isFinite(args.limit) ? rows.slice(0, args.limit - seen) : rows;

      const det = await client.fetchDetails(batch.map((r) => r.tender_id));
      seen += batch.length;
      gone += det.missing;
      contracts += det.contracts.length;
      withSupplier += det.contracts.filter((c) => c.supplier_edrpou).length;
      withContracts += new Set(det.contracts.map((c) => c.tender_id)).size;
      const nextId = batch[batch.length - 1].id;

      if (!args.dryRun) {
        const tx = await pool.connect();
        try {
          await tx.query('BEGIN');
          const tq = buildUpsert(det.records);
          if (tq) await tx.query(tq.text, tq.values);
          const cq = buildContractsUpsert(det.contracts);
          if (cq) await tx.query(cq.text, cq.values);
          await tx.query(
            `INSERT INTO prozorro_sync_state (feed, next_offset, last_date_modified, updated_at)
             VALUES ($1, $2, NULL, now())
             ON CONFLICT (feed) DO UPDATE SET next_offset = EXCLUDED.next_offset, updated_at = now()`,
            [key, String(nextId)],
          );
          await tx.query('COMMIT');
        } catch (e) {
          await tx.query('ROLLBACK').catch(() => undefined);
          throw e;
        } finally {
          tx.release();
        }
      }
      lastId = nextId;

      const secs = (Date.now() - t0) / 1000;
      log(`id<=${lastId}: ${seen} tenders (${(seen / secs).toFixed(1)}/s), ${withContracts} with contracts, ` +
        `${contracts} contracts (${withSupplier} with supplier), gone=${gone}`);
    }
  } finally {
    log(`Stopped: ${reason}. ${seen} tenders in ${((Date.now() - t0) / 1000).toFixed(0)}s; ` +
      `${contracts} contracts, ${withSupplier} with supplier; cursor id=${lastId}`);
    await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    lockClient.release();
    await pool.end();
    client.destroy();
  }
}

if (require.main === module) {
  main().catch((e) => {
    log(`FAILED: ${(e as Error).stack || e}`);
    process.exit(1);
  });
}
