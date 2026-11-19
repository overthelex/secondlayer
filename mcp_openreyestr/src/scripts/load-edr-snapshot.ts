/**
 * Load one ЄДР dump into the history schema edr_hist as a dated snapshot.
 *
 * Usage:
 *   node dist/scripts/load-edr-snapshot.js --file <zip|xml> [--file <zip|xml> ...] --snapshot YYYY-MM-DD
 *        [--source "<where the dump came from>"] [--limit N] [--dry-run] [--statement-timeout 90min]
 *
 * Every file given in one call is one snapshot (e.g. UO.xml and FSU.xml of the same week).
 * Snapshots may be loaded in any order; a date (per kind) that is already loaded is skipped.
 * --limit N (smoke tests) reads only N subjects and implies --dry-run: the fold runs and is
 * rolled back, so a partial dump is never recorded as the snapshot. ФОП files /
 * zip members are skipped. Formats: SUBJECT (2020-2026, verified), RECORD (2018-2019) and
 * ROW (2016-2017) are EXPERIMENTAL until checked on the real dumps.
 *
 * Environment: POSTGRES_HOST / POSTGRES_PORT / POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB.
 */
import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { loadEdrSnapshot } from '../services/edr-history/loader';

function parseArgs(argv: string[]) {
  const out: { files: string[]; snapshot?: string; source?: string; limit?: number; timeout?: string; dryRun?: boolean } = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const [k, inline] = argv[i].split(/=(.*)/s, 2);
    const val = () => (inline !== undefined ? inline : argv[++i]);
    if (k === '--file') out.files.push(val());
    else if (k === '--snapshot') out.snapshot = val();
    else if (k === '--source') out.source = val();
    else if (k === '--limit') {
      const v = val();
      if (!/^[1-9]\d*$/.test(v || '')) throw new Error(`--limit must be a positive integer, got ${v}`);
      out.limit = Number(v);
    } else if (k === '--dry-run') out.dryRun = true;
    else if (k === '--statement-timeout') out.timeout = val();
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.files.length || !args.snapshot) {
    console.error('Usage: load-edr-snapshot --file <zip|xml> [--file ...] --snapshot YYYY-MM-DD [--source TEXT] [--limit N] [--dry-run]');
    process.exit(2);
  }
  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435'),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'openreyestr',
    max: 2,
  });
  try {
    const r = await loadEdrSnapshot(pool, {
      snapshot: args.snapshot,
      source: args.source || `file:${args.files.join(',')}`,
      files: args.files,
      limit: args.limit,
      dryRun: args.dryRun,
      statementTimeout: args.timeout,
    });
    console.log(JSON.stringify(r, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('load-edr-snapshot failed:', err);
  process.exit(1);
});
