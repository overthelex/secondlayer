/**
 * Link the foreign_entity nodes of the ЄДР relationship graph to foreign registers (LEXAI-2321):
 * Cyprus DRCOR (cy_companies / cy_officials), ICIJ Offshore Leaks (icij_nodes) and Companies House
 * numbers. Reads graph.node of this database and the registers of the secondlayer database, writes
 * graph.foreign_ref / graph.foreign_officer here (migration 034); see services/graph/foreign-refs.ts.
 * The next build-graph run folds them in (attrs.links, 'head' edges with source 'cy_drcor');
 * --apply-to-graph also writes attrs.links of the live graph.node at once.
 *
 * Usage:
 *   node dist/scripts/import-foreign-refs.js [--dry-run] [--apply-to-graph] [--icij-max N]
 *
 * Environment: POSTGRES_HOST / POSTGRES_PORT / POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB
 * (this database); SOURCE_DATABASE_URL (the secondlayer database with cy_companies, icij_nodes).
 */
import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { collectForeignRefs, writeForeignRefs } from '../services/graph/foreign-refs';

async function main() {
  const argv = process.argv.slice(2);
  let dryRun = false;
  let applyToGraph = false;
  let icijMax = 5;
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dry-run': dryRun = true; break;
      case '--apply-to-graph': applyToGraph = true; break;
      case '--icij-max': {
        const v = argv[++i];
        if (!/^[1-9]\d*$/.test(v || '')) throw new Error('--icij-max must be a positive integer');
        icijMax = Number(v); break;
      }
      default: throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  if (!sourceUrl) throw new Error('SOURCE_DATABASE_URL (the secondlayer database) is required');
  const target = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435'),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'openreyestr',
    max: 2,
  });
  const source = new Pool({ connectionString: sourceUrl, max: 2 });
  try {
    const t = await target.connect();
    try {
      if (!dryRun && !(await t.query(`SELECT to_regclass('graph.foreign_ref') AS t`)).rows[0].t) {
        throw new Error('graph.foreign_ref missing: run migration 034_graph_foreign_refs.sql');
      }
      const { refs, officers, counts } = await collectForeignRefs(t, source, { icijMaxCandidates: icijMax, log: m => console.error(m) });
      const applied = dryRun ? {} : await writeForeignRefs(t, refs, officers, { applyToGraph });
      console.log(JSON.stringify({ dryRun, applyToGraph, counts, applied }, null, 2));
    } finally {
      t.release();
    }
  } finally {
    await Promise.all([target.end(), source.end()]);
  }
}

main().catch(err => {
  console.error('import-foreign-refs failed:', err);
  process.exit(1);
});
