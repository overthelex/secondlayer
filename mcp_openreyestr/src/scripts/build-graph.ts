/**
 * Build the ЄДР relationship graph (schema graph, migration 030; LEXAI-2303).
 *
 * Usage:
 *   node dist/scripts/build-graph.js [--limit N [--from-edrpou CODE]] [--dry-run]
 *        [--current yes|no|auto] [--current-date YYYY-MM-DD] [--rekey-addresses]
 *        [--hub-company N] [--hub-person N] [--hub-address N] [--hub-foreign N] [--hub-organisation N] [--mass-address N]
 *        [--reg-gap N] [--reg-per-day N] [--statement-timeout 3h] [--work-mem 256MB] [--keep-stage] [--no-prozorro]
 *        [--no-court] [--court-max-parties N] [--hub-court N]
 *
 * A full rebuild stages everything in schema graph_stage and swaps it in with one transaction:
 * graph.node / graph.edge stay queryable meanwhile. --limit N builds a sample of the first N
 * companies by code (from --from-edrpou) and SWAPS IT IN as well: run it in a scratch database.
 * --dry-run only counts the sources (read-only). Hub thresholds are computed from the degree
 * distribution of the build (keys.ts HUB_POLICY, stored in graph.build.hub_thresholds); --hub-*
 * and --mass-address override them. Personal numbers (РНОКПП, passport series) are stripped from
 * names and text attributes (graph-norm/personal-ids.ts, LEXAI-2322); the build FAILS before the
 * swap if a 10-digit run is left in a node label / key or an edge attribute (builder.ts
 * checkPersonalIds, which also documents the same check as SQL for the live graph), or passport
 * data / a date of birth in a node (graph/foreign-founders.ts checkPassportsAndDob, LEXAI-2321).
 * Links to foreign registers come from graph.foreign_ref (run import-foreign-refs.js before the
 * build; without migration 034 the build has none). ProZorro supplier addresses are added as
 * registered_at edges with source 'prozorro' (LEXAI-2317, services/graph/prozorro-addresses.ts);
 * --no-prozorro leaves them out. Heavy queries: run off-peak, e.g. under
 * `nice` and with a statement timeout (default 3h per statement).
 *
 * co_party edges come from graph.court_party, filled by load-court-parties.js (LEXAI-2304);
 * --no-court leaves them out, --court-max-parties / --hub-court override the court.ts defaults.
 *
 * Environment: POSTGRES_HOST / POSTGRES_PORT / POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB.
 */
import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { buildGraph, BuildOptions } from '../services/graph/builder';

function parseArgs(argv: string[]): BuildOptions {
  const o: BuildOptions = {};
  const hub: Record<string, number> = {};
  const int = (k: string, v: string) => {
    if (!/^[1-9]\d*$/.test(v || '')) throw new Error(`${k} must be a positive integer, got ${v}`);
    return Number(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const [k, inline] = argv[i].split(/=(.*)/s, 2);
    const val = () => (inline !== undefined ? inline : argv[++i]);
    switch (k) {
      case '--limit': o.limit = int(k, val()); break;
      case '--from-edrpou': o.fromEdrpou = val(); break;
      case '--dry-run': o.dryRun = true; break;
      case '--current': {
        const v = val();
        if (v !== 'yes' && v !== 'no' && v !== 'auto') throw new Error('--current must be yes, no or auto');
        o.includeCurrent = v; break;
      }
      case '--current-date': o.currentDate = val(); break;
      case '--rekey-addresses': o.rekeyAddresses = true; break;
      case '--hub-company': hub.company = int(k, val()); break;
      case '--hub-person': hub.person_name = int(k, val()); break;
      case '--hub-address': hub.address = int(k, val()); break;
      case '--hub-foreign': hub.foreign_entity = int(k, val()); break;
      case '--hub-organisation': hub.organisation = int(k, val()); break;
      case '--mass-address': o.massRegistrationMinDegree = int(k, val()); break;
      case '--reg-gap': o.regNeighbourMaxGap = int(k, val()); break;
      case '--reg-per-day': o.regNeighbourMaxPerDay = int(k, val()); break;
      case '--statement-timeout': o.statementTimeout = val(); break;
      case '--work-mem': o.workMem = val(); break;
      case '--keep-stage': o.keepStage = true; break;
      case '--no-prozorro': o.prozorroAddresses = false; break;
      case '--no-court': o.court = false; break;
      case '--court-max-parties': o.court = { ...(o.court || {}), maxPartiesPerDecision: int(k, val()) }; break;
      case '--hub-court': o.court = { ...(o.court || {}), hubThreshold: int(k, val()) }; break;
      default: throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  if (Object.keys(hub).length) o.hubThresholds = hub;
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
  try {
    const r = await buildGraph(pool, opts);
    console.log(JSON.stringify(r, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('build-graph failed:', err);
  process.exit(1);
});
