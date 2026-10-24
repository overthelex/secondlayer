/**
 * Sync bill cards (status, stage, committee, url) from the full Rada feed into rada.bills.
 *
 * LEXAI-2099: rada.bills was only filled from `billinfo_list-sklN.json`, which carries no
 * status, stage or url, so every bill had them NULL. This reads `billinfo-sklN.json`
 * (the full cards, ~140 MB) and upserts by bill_number. It never deletes; full_text,
 * explanatory_note and initiator_ids are left as they are.
 *
 * Usage (inside the rada container):
 *   node --max-old-space-size=4096 dist/scripts/sync-bills.js           # convocation 9
 *   LIMIT=50 node --max-old-space-size=4096 dist/scripts/sync-bills.js  # small test batch
 *
 * Env:
 *   POSTGRES_* / POSTGRES_SCHEMA  as for the server (Database)
 *   CONVOCATIONS  comma-separated skl numbers, default "9" (modern feed only)
 *   LIMIT         upsert only the first N cards (test runs)
 *   FEED_FILE     read a downloaded billinfo-sklN.json instead of fetching it
 *                 (one convocation only; for hosts whose containers cannot reach data.rada.gov.ua)
 */

import { Database } from '../database/database';
import { readFileSync } from 'fs';
import { BillFeedRow, billInfoToRow, fetchBillFeed, parseBillFeed } from '../services/bill-feed';
import { logger } from '../utils/logger';

const BATCH_SIZE = 200;
const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_BILLS || '86400', 10);

const COLS = [
  'bill_number', 'title', 'registration_date', 'status', 'stage', 'initiator_type',
  'initiator_names', 'main_committee_name', 'subject_area', 'url', 'metadata',
] as const;

/** Builds one multi-row upsert keyed by bill_number. Exported for tests. */
export function buildUpsert(rows: BillFeedRow[], cacheTtlSeconds: number): { sql: string; params: any[] } {
  // $1 = cache TTL; row values start at $2.
  const params: any[] = [cacheTtlSeconds];
  const tuples: string[] = [];
  let i = 2;
  for (const r of rows) {
    const vals = [
      r.bill_number, r.title, r.registration_date, r.status, r.stage, r.initiator_type,
      r.initiator_names, r.main_committee_name, r.subject_area, r.url, JSON.stringify(r.metadata),
    ];
    tuples.push(`(${vals.map(() => `$${i++}`).join(', ')}, NOW(), NOW() + make_interval(secs => $1), NOW())`);
    params.push(...vals);
  }
  // An empty initiator list from the feed must not wipe names we already have.
  const sql = `
    INSERT INTO bills (${COLS.join(', ')}, cached_at, cache_expires_at, updated_at)
    VALUES ${tuples.join(',\n')}
    ON CONFLICT (bill_number) DO UPDATE SET
      title = EXCLUDED.title,
      registration_date = COALESCE(EXCLUDED.registration_date, bills.registration_date),
      status = COALESCE(EXCLUDED.status, bills.status),
      stage = COALESCE(EXCLUDED.stage, bills.stage),
      initiator_type = COALESCE(EXCLUDED.initiator_type, bills.initiator_type),
      initiator_names = CASE WHEN cardinality(EXCLUDED.initiator_names) > 0
                             THEN EXCLUDED.initiator_names ELSE bills.initiator_names END,
      main_committee_name = COALESCE(EXCLUDED.main_committee_name, bills.main_committee_name),
      subject_area = COALESCE(EXCLUDED.subject_area, bills.subject_area),
      url = COALESCE(EXCLUDED.url, bills.url),
      metadata = COALESCE(bills.metadata, '{}'::jsonb) || EXCLUDED.metadata,
      cached_at = NOW(),
      cache_expires_at = EXCLUDED.cache_expires_at,
      updated_at = NOW()
  `;
  return { sql, params };
}

async function main(): Promise<void> {
  const convs = (process.env.CONVOCATIONS || process.argv[2] || '9')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));
  const limit = parseInt(process.env.LIMIT || '0', 10) || 0;

  const db = new Database();
  await db.connect();
  try {
    for (const conv of convs) {
      const feedFile = process.env.FEED_FILE;
      const { bills, modern } = feedFile
        ? { bills: parseBillFeed(readFileSync(feedFile, 'utf8')), modern: true }
        : await fetchBillFeed(conv);
      if (feedFile) console.log(`skl${conv}: ${bills.length} cards read from ${feedFile}`);
      if (!modern) {
        console.log(`skl${conv}: only the legacy feed exists (no status/stage), skipping`);
        continue;
      }

      // Dedupe by bill_number (ON CONFLICT rejects the same key twice in one statement).
      const byNumber = new Map<string, BillFeedRow>();
      let skipped = 0;
      for (const raw of bills) {
        const row = billInfoToRow(raw, conv);
        if (!row) { skipped++; continue; }
        byNumber.set(row.bill_number, row);
      }
      let rows = [...byNumber.values()];
      if (limit > 0) rows = rows.slice(0, limit);

      let upserted = 0;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const { sql, params } = buildUpsert(rows.slice(i, i + BATCH_SIZE), CACHE_TTL_SECONDS);
        const res = await db.query(sql, params);
        upserted += res.rowCount || 0;
        if (i > 0 && i % (BATCH_SIZE * 20) === 0) {
          console.log(`   …${i.toLocaleString()}/${rows.length.toLocaleString()} bills upserted`);
        }
      }
      const withStatus = rows.filter((r) => r.status).length;
      const withStage = rows.filter((r) => r.stage).length;
      console.log(
        `skl${conv}: ${upserted} bills upserted (status ${withStatus}, stage ${withStage}, skipped ${skipped})`
      );
    }
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('RADA bills sync failed', { error: error.message });
    console.error('Fatal:', error.message);
    process.exit(1);
  });
}
