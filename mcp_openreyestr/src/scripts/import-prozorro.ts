/**
 * ProZorro tenders: incremental import (LEXAI-2089)
 *
 * Walks the public tenders feed (ascending by dateModified) from a saved cursor,
 * fetches each tender's details, and upserts metadata into prozorro_tenders
 * (ON CONFLICT (tender_id)). Never deletes or truncates.
 *
 * Cursor: prozorro_sync_state.next_offset (the feed's opaque next_page.offset),
 * committed in the same transaction as the page's rows. A crash or kill replays
 * at most one page. Without a cursor the start is max(date_modified) in the
 * table minus a 5-minute overlap.
 *
 * Usage (inside the openreyestr container):
 *   node dist/scripts/import-prozorro.js                        # resume from cursor / table max
 *   node dist/scripts/import-prozorro.js --max-minutes=120      # daily run, stops gracefully
 *   node dist/scripts/import-prozorro.js --from=2025-01-14T17:54:00Z --until=2025-01-15T17:54:00Z
 *   node dist/scripts/import-prozorro.js --dry-run --limit=200  # fetch + parse, no writes
 *   node dist/scripts/import-prozorro.js --reset-cursor         # restart from table max
 *
 * Env: PROZORRO_CONCURRENCY (detail requests in flight, default 10),
 *      PROZORRO_PAGE_SIZE (feed page, max 1000, default 1000),
 *      PROZORRO_DELAY_MS (per-worker pause between requests, default 0),
 *      POSTGRES_HOST/PORT/USER/PASSWORD/DB.
 */
import dotenv from 'dotenv';
dotenv.config();

import { Pool, PoolClient } from 'pg';
import https from 'https';
import {
  buildUpsert,
  extractTenderData,
  parseArgs,
  retryDelayMs,
  toUnixSeconds,
  TenderRecord,
} from './lib/prozorro-feed';

const API_BASE = process.env.PROZORRO_API_BASE || 'https://public-api.prozorro.gov.ua/api/2.5';
const CONCURRENCY = Math.max(1, parseInt(process.env.PROZORRO_CONCURRENCY || '10', 10));
const PAGE_SIZE = Math.min(1000, Math.max(1, parseInt(process.env.PROZORRO_PAGE_SIZE || '1000', 10)));
const DELAY_MS = Math.max(0, parseInt(process.env.PROZORRO_DELAY_MS || '0', 10));
const MAX_ATTEMPTS = 8;
const FEED = 'tenders';
const OVERLAP_SECONDS = 300;
const LOCK_KEY = 2089_0001; // pg advisory lock: one importer at a time

const agent = new https.Agent({ keepAlive: true, maxSockets: CONCURRENCY + 2 });

/** Shared back-off gate: a 429 on any worker pauses all of them. */
let pausedUntil = 0;
let stopRequested = false;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

interface HttpResult { status: number; retryAfter: string | null; body: string }

function httpGet(url: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent, timeout: 60_000, headers: { 'User-Agent': 'legal.org.ua openreyestr importer' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        const ra = res.headers['retry-after'];
        resolve({ status: res.statusCode || 0, retryAfter: Array.isArray(ra) ? ra[0] : ra || null, body });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** GET JSON with retries. Returns null on 404/410 (tender gone). Throws after MAX_ATTEMPTS. */
async function fetchJson(url: string): Promise<any | null> {
  let lastErr = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const wait = pausedUntil - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      const res = await httpGet(url);
      if (res.status === 200) return JSON.parse(res.body);
      if (res.status === 404 || res.status === 410) return null;
      lastErr = `HTTP ${res.status}`;
      if (res.status === 429 || res.status === 503) {
        const delay = retryDelayMs(attempt, res.retryAfter);
        pausedUntil = Math.max(pausedUntil, Date.now() + delay);
        log(`  ${res.status} from API, all workers pause ${Math.round(delay / 1000)}s`);
        continue;
      }
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await sleep(retryDelayMs(attempt, null));
  }
  throw new Error(`${lastErr} after ${MAX_ATTEMPTS} attempts: ${url}`);
}

async function fetchDetails(ids: string[]): Promise<{ records: TenderRecord[]; missing: number }> {
  const records: TenderRecord[] = [];
  let missing = 0;
  let idx = 0;
  let failure: Error | null = null;
  async function worker(): Promise<void> {
    while (idx < ids.length && !failure) {
      const id = ids[idx++];
      try {
        const json = await fetchJson(`${API_BASE}/tenders/${id}`);
        const rec = json ? extractTenderData(json.data) : null;
        if (rec) records.push(rec);
        else missing++;
      } catch (e) {
        failure = e as Error;
      }
      if (DELAY_MS) await sleep(DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
  if (failure) throw failure;
  return { records, missing };
}

async function ensureSchema(pool: Pool): Promise<void> {
  // Same statements as migrations/018_prozorro_sync_state.sql; migrations are
  // not run on container start, so the importer brings its own prerequisites.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prozorro_sync_state (
      feed TEXT PRIMARY KEY,
      next_offset TEXT NOT NULL,
      last_date_modified TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  // The 1.03M historical rows were loaded with explicit ids and the sequence was
  // never advanced (last_value=1, max(id)=1120158): any new INSERT would collide
  // on the primary key. Never moves the sequence backwards.
  await pool.query(`
    SELECT setval(pg_get_serial_sequence('prozorro_tenders', 'id'),
                  GREATEST((SELECT COALESCE(max(id), 1) FROM prozorro_tenders),
                           (SELECT last_value FROM prozorro_tenders_id_seq)))`);
}

async function resolveStart(pool: Pool, args: ReturnType<typeof parseArgs>): Promise<{ offset: string; source: string }> {
  if (args.from) return { offset: String(toUnixSeconds(args.from)), source: `--from=${args.from}` };
  const hasState = (await pool.query(`SELECT to_regclass('prozorro_sync_state') IS NOT NULL AS ok`)).rows[0].ok;
  if (!args.resetCursor && hasState) {
    const st = await pool.query(`SELECT next_offset, last_date_modified FROM prozorro_sync_state WHERE feed = $1`, [FEED]);
    if (st.rows[0]) return { offset: st.rows[0].next_offset, source: `saved cursor (last item ${st.rows[0].last_date_modified})` };
  }
  // date_modified is Kyiv wall time without zone (see lib/prozorro-feed.ts).
  const r = await pool.query(
    `SELECT extract(epoch FROM max(date_modified) AT TIME ZONE 'Europe/Kyiv')::float8 AS ts, max(date_modified)::text AS max FROM prozorro_tenders`,
  );
  if (r.rows[0]?.ts == null) throw new Error('prozorro_tenders is empty: pass --from=<date> for an initial load');
  return { offset: String(Math.floor(r.rows[0].ts - OVERLAP_SECONDS)), source: `table max(date_modified)=${r.rows[0].max} minus ${OVERLAP_SECONDS}s` };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const untilTs = args.until ? toUnixSeconds(args.until) : null;
  const deadline = Number.isFinite(args.maxMinutes) ? Date.now() + args.maxMinutes * 60_000 : Infinity;

  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435', 10),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'openreyestr',
    max: 3,
  });

  const lockClient: PoolClient = await pool.connect();
  const lock = await lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
  if (!lock.rows[0].ok) {
    log('Another ProZorro import holds the lock; exiting.');
    lockClient.release();
    await pool.end();
    return;
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (stopRequested) process.exit(130);
      stopRequested = true;
      log(`${sig}: finishing the current page, then stopping (send again to abort)`);
    });
  }

  if (!args.dryRun) await ensureSchema(pool);
  const start = await resolveStart(pool, args);
  log(`ProZorro import: start offset ${start.offset} from ${start.source}; concurrency=${CONCURRENCY} page=${PAGE_SIZE}` +
    `${untilTs ? ` until=${args.until}` : ''}${args.dryRun ? ' DRY RUN' : ''}`);

  const t0 = Date.now();
  let offset = start.offset;
  let seen = 0, inserted = 0, updated = 0, skippedOlder = 0, missing = 0, pages = 0;
  let lastModified = '';
  let reason = 'caught up (empty feed page)';

  try {
    for (;;) {
      if (stopRequested) { reason = 'signal'; break; }
      if (Date.now() > deadline) { reason = `--max-minutes=${args.maxMinutes} reached`; break; }
      if (seen >= args.limit) { reason = `--limit=${args.limit} reached`; break; }

      const page = await fetchJson(`${API_BASE}/tenders?limit=${PAGE_SIZE}&offset=${encodeURIComponent(offset)}`);
      let items: { id: string; dateModified: string }[] = page?.data || [];
      if (items.length === 0) break;

      let hitUntil = false;
      if (untilTs !== null) {
        const kept = items.filter((t) => Date.parse(t.dateModified) / 1000 <= untilTs);
        hitUntil = kept.length < items.length;
        items = kept;
      }
      if (seen + items.length > args.limit) { items = items.slice(0, args.limit - seen); hitUntil = true; }

      const det = await fetchDetails(items.map((t) => t.id));
      missing += det.missing;
      seen += items.length;
      pages++;
      if (items.length) lastModified = items[items.length - 1].dateModified;

      // A truncated page must not advance the cursor past its unprocessed tail.
      const nextOffset: string | null = hitUntil ? null : page.next_page?.offset ?? null;

      if (!args.dryRun) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const q = buildUpsert(det.records);
          if (q) {
            const r = await client.query(q.text, q.values);
            const ins = r.rows.filter((x) => x.is_insert).length;
            inserted += ins;
            updated += r.rows.length - ins;
            skippedOlder += new Set(det.records.map((x) => x.tender_id)).size - r.rows.length;
          }
          if (nextOffset) {
            await client.query(
              `INSERT INTO prozorro_sync_state (feed, next_offset, last_date_modified, updated_at)
               VALUES ($1, $2, $3, now())
               ON CONFLICT (feed) DO UPDATE SET next_offset = EXCLUDED.next_offset,
                 last_date_modified = EXCLUDED.last_date_modified, updated_at = now()`,
              [FEED, nextOffset, lastModified],
            );
          }
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw e;
        } finally {
          client.release();
        }
      }

      const secs = (Date.now() - t0) / 1000;
      log(`page ${pages}: +${items.length} (total ${seen}, ${(seen / secs).toFixed(1)}/s) new=${inserted} upd=${updated} ` +
        `older=${skippedOlder} gone=${missing} | feed at ${lastModified}`);

      if (hitUntil) { reason = untilTs !== null && seen < args.limit ? `--until=${args.until} reached` : `--limit=${args.limit} reached`; break; }
      if (!nextOffset) { reason = 'feed returned no next_page'; break; }
      offset = nextOffset;
    }
  } finally {
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    log(`Stopped: ${reason}. ${seen} tenders in ${secs}s: new=${inserted} updated=${updated} older-skipped=${skippedOlder} gone=${missing}; feed at ${lastModified || '-'}`);
    await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    lockClient.release();
    await pool.end();
    agent.destroy();
  }
}

main().catch((e) => {
  log(`FAILED: ${(e as Error).stack || e}`);
  process.exit(1);
});
