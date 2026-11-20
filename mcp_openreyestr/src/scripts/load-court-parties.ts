/**
 * Copy the court decision parties that carry a company code (ЄДРПОУ) from the backend database
 * (edrsr_parties + edrsr_documents) into graph.court_party of the openreyestr database, for the
 * co_party edges of the relationship graph (LEXAI-2304, services/graph/court.ts). Run it before
 * build-graph.js; the next build picks the rows up.
 *
 * Usage:
 *   node dist/scripts/load-court-parties.js [--years 2024,2025] [--force] [--dry-run] [--batch N]
 *
 * Default: the years whose edrsr_parties_coverage.built_at changed since the last copy, never
 * copied, or among the last two (refreshed every run). --years copies exactly those years.
 * --dry-run reads the source and counts, writes nothing. The source session is READ ONLY.
 * Only 8-digit codes are copied: no names, no 10-digit РНОКПП.
 *
 * Environment:
 *   EDRSR_DATABASE_URL  the backend database (postgres://user:pass@host:5432/db), read only
 *   POSTGRES_HOST / POSTGRES_PORT / POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB  openreyestr
 */
import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { loadCourtParties, LoadOptions } from '../services/graph/court';

function parseArgs(argv: string[]): LoadOptions {
  const o: LoadOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const [k, inline] = argv[i].split(/=(.*)/s, 2);
    const val = () => (inline !== undefined ? inline : argv[++i]);
    switch (k) {
      case '--years': {
        const v = val() || '';
        if (!/^\d{4}(,\d{4})*$/.test(v)) throw new Error('--years must be a comma-separated list of years');
        o.years = v.split(',').map(Number); break;
      }
      case '--force': o.force = true; break;
      case '--dry-run': o.dryRun = true; break;
      case '--batch': {
        const v = val();
        if (!/^[1-9]\d*$/.test(v || '')) throw new Error('--batch must be a positive integer');
        o.batchSize = Number(v); break;
      }
      default: throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const url = process.env.EDRSR_DATABASE_URL;
  if (!url) throw new Error('EDRSR_DATABASE_URL is not set (the backend database with edrsr_parties)');
  const source = new Pool({ connectionString: url, max: 1, options: '-c default_transaction_read_only=on' });
  const target = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435'),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'openreyestr',
    max: 1,
  });
  try {
    const r = await loadCourtParties(source, target, opts);
    console.log(JSON.stringify(r, null, 2));
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch(err => {
  console.error('load-court-parties failed:', err);
  process.exit(1);
});
