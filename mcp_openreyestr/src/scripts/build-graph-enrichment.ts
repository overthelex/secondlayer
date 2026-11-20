/**
 * Build the enrichment layer of the relationship graph (LEXAI-2305, migration 032): node flags
 * (sanctions, tax / ЄСВ debt, debtors, enforcement, termination, НБУ licences, НАЗК declarants) and
 * extra edges (creditor, supplier, declared_owner, family, shareholder). Run AFTER build-graph.js:
 * only rows whose nodes are in the current graph are kept. See services/graph/enrichment.ts.
 *
 * Usage:
 *   node dist/scripts/build-graph-enrichment.js [--only step,step] [--skip step,step] [--no-external]
 *        [--today YYYY-MM-DD] [--statement-timeout 3h] [--work-mem 256MB] [--keep-stage]
 *
 * Steps: rnbo_sanctions, tax_debt, esv_debt, debtors, enforcement_proceedings, termination_started,
 * prozorro_contracts, nazk (openreyestr database); nbu_fin_licenses, opendata_securities_owners,
 * nazk_war_sanctions (secondlayer database, SL_POSTGRES_*). A step that does not run (excluded,
 * table missing, no external database) keeps its rows of the previous build, so `--only nazk`
 * refreshes the НАЗК part alone, e.g. after the declarations load.
 *
 * Environment: POSTGRES_HOST / POSTGRES_PORT / POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB
 * (openreyestr), SL_POSTGRES_HOST / SL_POSTGRES_PORT / SL_POSTGRES_USER / SL_POSTGRES_PASSWORD /
 * SL_POSTGRES_DB (secondlayer, read-only use; optional).
 */
import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { buildEnrichment, EnrichmentOptions } from '../services/graph/enrichment';

function parseArgs(argv: string[]): EnrichmentOptions & { noExternal?: boolean } {
  const o: EnrichmentOptions & { noExternal?: boolean } = {};
  const list = (v: string) => (v || '').split(',').map(s => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const [k, inline] = argv[i].split(/=(.*)/s, 2);
    const val = () => (inline !== undefined ? inline : argv[++i]);
    switch (k) {
      case '--only': o.only = list(val()); break;
      case '--skip': o.skip = list(val()); break;
      case '--no-external': o.noExternal = true; break;
      case '--today': o.today = val(); break;
      case '--statement-timeout': o.statementTimeout = val(); break;
      case '--work-mem': o.workMem = val(); break;
      case '--keep-stage': o.keepStage = true; break;
      default: throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435'),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'openreyestr',
    max: 2,
  });
  const ext = !opts.noExternal && process.env.SL_POSTGRES_HOST ? new Pool({
    host: process.env.SL_POSTGRES_HOST,
    port: parseInt(process.env.SL_POSTGRES_PORT || '5432'),
    user: process.env.SL_POSTGRES_USER || 'secondlayer',
    password: process.env.SL_POSTGRES_PASSWORD,
    database: process.env.SL_POSTGRES_DB || 'secondlayer',
    max: 1,
    statement_timeout: 30 * 60 * 1000,
    options: '-c default_transaction_read_only=on',
  }) : null;
  if (!ext) console.log('No external (secondlayer) database: НБУ / НКЦПФР / War & Sanctions keep their previous rows');
  try {
    const r = await buildEnrichment(pool, { ...opts, external: ext });
    console.log(JSON.stringify(r, null, 2));
  } finally {
    await pool.end();
    if (ext) await ext.end();
  }
}

main().catch(err => {
  console.error('build-graph-enrichment failed:', err);
  process.exit(1);
});
