/**
 * Derive settlement-scoped street renamings from ЄДР address history (LEXAI-2309).
 *
 * For every company, consecutive registered addresses (edr_hist.history, field 'address',
 * 2016-2021 snapshots) and, as the newest value, the latest Prozorro supplier address after the
 * last 2021 snapshot (the 2026 ЄДР dumps carry no address) are compared: same settlement and
 * building, another street -> a candidate 'old -> new'. Candidates are counted over companies and
 * filtered (services/graph-norm/street-renaming-derive.ts); the rows replace source='edr_history'
 * in street_renamings_scoped.
 *
 *   node dist/scripts/derive-street-renamings.js --dry-run --out /path/renamings.csv \
 *     [--candidates-out /path/candidates.csv] [--sample 2000] [--min-companies 3] \
 *     [--min-buildings 2] [--dominance 0.8] [--limit 50000] [--no-prozorro]
 *   node dist/scripts/derive-street-renamings.js            # writes the table
 *
 * --dry-run opens a READ ONLY transaction and writes CSV files only. No company identifiers are
 * written to any output.
 */
import dotenv from 'dotenv';
import { createWriteStream, WriteStream } from 'fs';
import { Pool, PoolClient } from 'pg';
import { normAddress, parseStreetName, streetCoreKey } from '../services/graph-norm/address';
import { buildStreetRenamingIndex } from '../services/graph-norm/street-renamings';
import {
  AddressObservation, candidatePairs, FilterOptions, RenamingAggregator, ScopedRenaming, streetKeyOf,
} from '../services/graph-norm/street-renaming-derive';

dotenv.config();

interface Args {
  dryRun: boolean;
  out: string | null;
  candidatesOut: string | null;
  sample: number;
  limit: number;
  prozorro: boolean;
  filter: FilterOptions;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, out: null, candidatesOut: null, sample: 0, limit: 0, prozorro: true, filter: {} };
  for (let i = 0; i < argv.length; i++) {
    const [k, inline] = argv[i].split(/=(.*)/s, 2);
    const val = () => (inline !== undefined ? inline : argv[++i]);
    if (k === '--dry-run') a.dryRun = true;
    else if (k === '--out') a.out = val();
    else if (k === '--candidates-out') a.candidatesOut = val();
    else if (k === '--sample') a.sample = Number(val());
    else if (k === '--limit') a.limit = Number(val());
    else if (k === '--no-prozorro') a.prozorro = false;
    else if (k === '--min-companies') a.filter.minCompanies = Number(val());
    else if (k === '--min-buildings') a.filter.minBuildings = Number(val());
    else if (k === '--dominance') a.filter.dominance = Number(val());
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (a.dryRun && !a.out) throw new Error('--dry-run needs --out <csv>');
  return a;
}

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLine = (xs: unknown[]) => xs.map(csvCell).join(',') + '\n';
const isoDate = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

async function* cursorRows(client: PoolClient, sql: string, batch = 20000): AsyncGenerator<any> {
  await client.query(`DECLARE derive_cur NO SCROLL CURSOR FOR ${sql}`);
  for (;;) {
    const res = await client.query(`FETCH ${batch} FROM derive_cur`);
    if (!res.rows.length) break;
    for (const r of res.rows) yield r;
  }
  await client.query('CLOSE derive_cur');
}

const PROZORRO_SQL = `SELECT DISTINCT ON (supplier_edrpou) supplier_edrpou AS edrpou,
    supplier_region, supplier_locality, supplier_address,
    COALESCE(date_signed, contract_date, tender_date_modified)::date AS d
  FROM prozorro_contracts
  WHERE supplier_edrpou ~ '^[0-9]{8}$' AND supplier_address IS NOT NULL
    AND COALESCE(date_signed, contract_date, tender_date_modified) >= DATE '2021-11-02'
  ORDER BY supplier_edrpou, COALESCE(date_signed, contract_date, tender_date_modified) DESC`;

/** A Prozorro supplier address as one ЄДР-like string. */
export function prozorroAddress(region: string | null, locality: string | null, address: string): string {
  return ['Україна', region, locality, address].map((x) => (x ?? '').trim()).filter(Boolean).join(', ');
}

/** The runtime index re-parses the name samples; keep a row only if they give back its keys. */
function roundTrips(r: ScopedRenaming): boolean {
  const o = parseStreetName(r.oldName);
  const c = parseStreetName(r.currentName);
  return !!o && !!c && streetKeyOf(o.type, o.name) === r.oldKey && streetKeyOf(c.type, c.name) === r.currentKey;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435'),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'openreyestr',
    application_name: 'derive-street-renamings',
  });
  const client = await pool.connect();
  try {
    await client.query(args.dryRun ? 'BEGIN READ ONLY' : 'BEGIN');
    await client.query("SET LOCAL statement_timeout = '2h'");

    // 1. newest addresses from Prozorro
    const latest = new Map<string, AddressObservation>();
    if (args.prozorro) {
      for await (const r of cursorRows(client, PROZORRO_SQL)) {
        latest.set(r.edrpou, { value: prozorroAddress(r.supplier_region, r.supplier_locality, r.supplier_address), date: isoDate(r.d) });
      }
      log(`prozorro: ${latest.size} supplier addresses after 2021-11-01`);
    }

    // 2. stream the history, one company at a time
    const agg = new RenamingAggregator();
    let companies = 0;
    let withCandidates = 0;
    let fromProzorro = 0;
    let candidates = 0;
    let cur: string | null = null;
    let obs: AddressObservation[] = [];
    const flush = () => {
      if (cur === null) return;
      const p = latest.get(cur);
      if (p && obs.length && p.date > obs[obs.length - 1].date) obs.push(p);
      const c = candidatePairs(obs);
      if (c.length) {
        withCandidates++;
        candidates += c.length;
        if (p && c.some((x) => x.date === p.date)) fromProzorro++;
        agg.add(c);
      }
      companies++;
      if (companies % 200000 === 0) log(`${companies} companies, ${candidates} candidates`);
    };
    const historySql = `SELECT edrpou, value, first_snapshot FROM edr_hist.history
      WHERE field = 'address' AND value IS NOT NULL AND edrpou <> '00000000'
      ORDER BY edrpou, first_snapshot`;
    for await (const r of cursorRows(client, historySql)) {
      if (r.edrpou !== cur) {
        flush();
        if (args.limit && companies >= args.limit) break;
        cur = r.edrpou;
        obs = [];
      }
      obs.push({ value: r.value, date: isoDate(r.first_snapshot) });
    }
    if (!args.limit || companies < args.limit) flush();
    log(`history: ${companies} companies, ${withCandidates} with candidates (${fromProzorro} via Prozorro), ${candidates} candidates`);

    if (args.candidatesOut) {
      const w = createWriteStream(args.candidatesOut);
      w.write(csvLine(['settlement_key', 'old_street_key', 'old_name_sample', 'new_street_key', 'new_name_sample', 'companies', 'buildings', 'first_seen', 'last_seen']));
      let n = 0;
      for (const p of agg.pairs()) {
        w.write(csvLine([p.settlementKey, p.oldKey, p.oldName, p.newKey, p.newName, p.companies, p.buildings, p.first, p.last]));
        n++;
      }
      await new Promise((res) => w.end(res));
      log(`candidates: ${n} pairs -> ${args.candidatesOut}`);
    }

    // 3. threshold grid, then the chosen filter
    for (const [c, b] of [[2, 1], [2, 2], [3, 1], [3, 2], [4, 2], [5, 2], [5, 3]]) {
      const { stats } = agg.filter({ ...args.filter, minCompanies: c, minBuildings: b });
      log(`grid companies>=${c} buildings>=${b}: ${JSON.stringify(stats)}`);
    }
    const { rows: all, stats } = agg.filter(args.filter);
    const rows = all.filter(roundTrips);
    log(`filter ${JSON.stringify(args.filter)}: ${JSON.stringify(stats)}; ${all.length - rows.length} dropped (name samples do not round-trip)`);

    // 4. compare with the OSM table (no settlement there: agreement on the names only)
    const osm = new Set<string>();
    const osmOld = new Set<string>();
    const osmRes = await client.query('SELECT COALESCE(current_name_uk, current_name) AS c, old_names FROM street_renamings');
    const coreOf = (s: string) => { const r = parseStreetName(s) ?? parseStreetName(`вулиця ${s}`); return r ? streetCoreKey(r.name) : null; };
    for (const r of osmRes.rows) {
      const c = coreOf(String(r.c ?? ''));
      if (!c) continue;
      for (const o of r.old_names ?? []) {
        const oc = coreOf(String(o));
        if (!oc || oc === c) continue;
        osm.add(`${oc}>${c}`);
        osmOld.add(oc);
      }
    }
    const osmStatus = (r: ScopedRenaming) => {
      const oc = r.oldKey.split('|')[1];
      const cc = r.currentKey.split('|')[1];
      return osm.has(`${oc}>${cc}`) ? 'agree' : osmOld.has(oc) ? 'other' : 'none';
    };
    const osmCount = { agree: 0, other: 0, none: 0 };
    for (const r of rows) osmCount[osmStatus(r)]++;
    log(`osm: ${JSON.stringify(osmCount)}`);

    // 5. effect on current addresses
    if (args.sample > 0) {
      const idx = buildStreetRenamingIndex(rows.map((r) => ({ currentName: r.currentName, oldNames: [r.oldName], settlementKey: r.settlementKey })));
      const s = await client.query(`SELECT address FROM edr_hist.company WHERE address IS NOT NULL ORDER BY random() LIMIT ${Math.floor(args.sample)}`);
      let keyed = 0;
      let changed = 0;
      const examples: string[] = [];
      for (const r of s.rows) {
        const a = normAddress(r.address);
        if (!a.addressKey) continue;
        keyed++;
        const b = normAddress(r.address, { streetRenamings: idx });
        if (b.addressKey !== a.addressKey) {
          changed++;
          if (examples.length < 15) examples.push(`${a.settlementKey}: ${b.streetRenamedFrom} -> ${b.streetType} ${b.street}`);
        }
      }
      log(`sample: ${s.rows.length} addresses, ${keyed} with an addressKey, ${changed} change with scoped renamings (index ${JSON.stringify(idx.stats)})`);
      for (const e of examples) log(`  ${e}`);
    }

    // 6. output
    if (args.out) {
      const w: WriteStream = createWriteStream(args.out);
      w.write(csvLine(['settlement_key', 'old_street_key', 'old_name_sample', 'current_street_key', 'current_name_sample', 'companies', 'buildings', 'share', 'first_seen', 'last_seen', 'osm']));
      for (const r of rows) {
        w.write(csvLine([r.settlementKey, r.oldKey, r.oldName, r.currentKey, r.currentName, r.companies, r.buildings, r.share, r.firstSeen, r.lastSeen, osmStatus(r)]));
      }
      await new Promise((res) => w.end(res));
      log(`wrote ${rows.length} rows -> ${args.out}`);
    }

    if (args.dryRun) {
      await client.query('ROLLBACK');
    } else {
      await client.query("DELETE FROM street_renamings_scoped WHERE source = 'edr_history'");
      for (let i = 0; i < rows.length; i += 1000) {
        const chunk = rows.slice(i, i + 1000);
        const params: unknown[] = [];
        const values = chunk.map((r, j) => {
          params.push(r.settlementKey, r.oldKey, r.oldName, r.currentKey, r.currentName, r.companies, r.buildings, r.firstSeen, r.lastSeen);
          const b = j * 9;
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},'edr_history')`;
        });
        await client.query(
          `INSERT INTO street_renamings_scoped (settlement_key, old_street_key, old_name_sample, current_street_key,
             current_name_sample, companies, buildings, first_seen, last_seen, source) VALUES ${values.join(',')}`,
          params,
        );
      }
      await client.query('COMMIT');
      log(`street_renamings_scoped: ${rows.length} edr_history rows written`);
    }
    log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

