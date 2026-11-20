/**
 * Settlement-scoped street renamings from OpenStreetMap -> street_renamings_scoped, source='osm'
 * (LEXAI-2316).
 *
 * Data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright). The rows
 * this script writes are a derivative database under ODbL; anything that shows them must credit
 * «© OpenStreetMap contributors». OSM data and the extract files are never committed.
 *
 * 1. Extract (once per dump, in a throwaway container; see scripts/osm/README.md):
 *      python3 scripts/osm/extract_osm_streets.py ukraine-latest.osm.pbf <dir>
 * 2. Rows:
 *      node dist/scripts/import-osm-street-renamings.js --dir <dir> --dry-run --out <dir>/out
 *        [--admin-levels 9] [--sample 200] [--no-db]
 *      node dist/scripts/import-osm-street-renamings.js --dir <dir>      # replaces source='osm' rows
 *
 * --dry-run opens a READ ONLY transaction (or none with --no-db) and writes only CSV files:
 *   osm-street-renamings.csv  the rows
 *   osm-vs-edr.csv            every edr_history row with the OSM row for the same settlement + old street
 *   osm-sample.csv            a stratified sample of OSM-only rows to check by hand
 *   osm-old-global.csv        edr_history rows the old global OSM table (street_renamings) contradicted
 * Normal mode deletes the source='osm' rows and inserts the new ones in one transaction; the
 * other sources are untouched (the runtime cache prefers manual > edr_history > osm).
 */
import dotenv from 'dotenv';
import { createReadStream, createWriteStream, mkdirSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { Pool, PoolClient } from 'pg';
import { parseStreetName, streetCoreKey } from '../services/graph-norm/address';
import {
  OsmArea, OsmPlace, OsmRenamingAggregator, OsmRenamingRow, OsmSettlementIndex, OsmStreet, osmPairs, readStreetName,
} from '../services/graph-norm/osm-street-renamings';
import { sameStreetName } from '../services/graph-norm/street-renaming-derive';

dotenv.config();

interface Args {
  dir: string;
  dryRun: boolean;
  out: string | null;
  adminLevels: string[];
  sample: number;
  db: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { dir: '', dryRun: false, out: null, adminLevels: [], sample: 200, db: true };
  for (let i = 0; i < argv.length; i++) {
    const [k, inline] = argv[i].split(/=(.*)/s, 2);
    const val = () => (inline !== undefined ? inline : argv[++i]);
    if (k === '--dir') a.dir = val();
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--out') a.out = val();
    else if (k === '--admin-levels') a.adminLevels = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--sample') a.sample = Number(val());
    else if (k === '--no-db') a.db = false;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!a.dir) throw new Error('--dir <extract dir> is required');
  if (a.dryRun && !a.out) throw new Error('--dry-run needs --out <dir>');
  if (!a.dryRun && !a.db) throw new Error('--no-db only with --dry-run');
  return a;
}

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLine = (xs: unknown[]) => xs.map(csvCell).join(',') + '\n';

async function* ndjson<T>(path: string): AsyncGenerator<T> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) yield JSON.parse(line) as T;
}

async function writeCsv(path: string, header: string[], rows: unknown[][]): Promise<void> {
  const w = createWriteStream(path);
  w.write(csvLine(header));
  for (const r of rows) w.write(csvLine(r));
  await new Promise((res) => w.end(res));
  log(`${rows.length} rows -> ${path}`);
}

/** Deterministic shuffle (mulberry32), so a re-run gives the same sample. */
function shuffled<T>(xs: T[], seed = 2316): T[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const STRATA: Array<[string, (k: string) => boolean, number]> = [
  ['kyiv', (k) => k === 'UA-30|м|кив', 30],
  ['kharkiv', (k) => k === 'UA-63|м|харкив', 30],
  ['odesa', (k) => k === 'UA-51|м|одеса', 30],
  ['dnipro', (k) => k === 'UA-12|м|днипро', 30],
  ['lviv', (k) => k === 'UA-46|м|лвив', 25],
  ['other_city', (k) => k.split('|')[1] === 'м', 30],
  ['village', (k) => k.split('|')[1] === 'н', 25],
];
export const stratumOf = (settlementKey: string) => STRATA.find(([, f]) => f(settlementKey))?.[0] ?? 'other';

// Russian culture figures and places, the target of the 2022-2024 derussification (a rough classifier
// for the report; matched on folded keys: і/ї -> и, є -> е, no soft signs, no doubled letters)
const RUSSIAN = new RegExp('(?:^| )(?:' + [
  'пушкин', 'лермонтов', 'толсто', 'чайковск', 'чехов', 'ломоносов', 'суворов', 'кутузов', 'невск', 'московск',
  'росийск', 'руск', 'ленинградск', 'петербург', 'тургенев', 'достоевск', 'белинск', 'мусоргск', 'римск',
  'глинк', 'некрасов', 'крилов', 'грибоедов', 'маяковск', 'булгаков', 'цветаев', 'ахматов', 'бунин', 'есенин',
  'мичурин', 'менделев', 'циолковск', 'рахманинов', 'курск', 'брянск', 'смоленск', 'воронеж', 'тулск',
  'орловск', 'саратов', 'ярославск', 'новосибирск', 'уралск', 'волжск', 'кремлевск', 'тамбов', 'казанск',
  'сибирск', 'рязанск', 'пензенск', 'белгородск', 'новгородск', 'мурманск', 'архангелск', 'вологодск',
  'астраханск', 'челябинск', 'омск', 'томск', 'иркутск', 'тверск', 'калуж', 'псковск', 'ставропол', 'самарск',
  'горк', 'гончаров', 'островск', 'крамск', 'шишкин', 'репин', 'левитан', 'айвазовск', 'державин', 'карамзин',
  'герцен', 'огарев', 'чернишевск', 'добролюбов', 'писарев', 'радищев', 'короленк', 'куприн', 'паустовск', 'шолохов',
  'твардовск', 'симонов', 'фадеев', 'гайдар', 'ушаков', 'нахимов', 'макаров', 'корнилов', 'багратион', 'жуков',
].join('|') + ')');

/** 2022-2024 derussification: a dated tag says so, or the old name is a Russian figure / place. */
export function derussification(row: Pick<OsmRenamingRow, 'oldKey' | 'until'>): boolean {
  if (row.until !== null) return row.until >= 2022 && row.until <= 2024;
  return RUSSIAN.test(row.oldKey.split('|')[1]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();

  // 1. settlements
  const areas: OsmArea[] = [];
  for await (const a of ndjson<OsmArea>(join(args.dir, 'areas.ndjson'))) areas.push(a);
  const places: OsmPlace[] = [];
  for await (const p of ndjson<OsmPlace>(join(args.dir, 'places.ndjson'))) places.push(p);
  const idx = new OsmSettlementIndex(areas, places, { settlementAdminLevels: args.adminLevels });
  log(`settlements: ${JSON.stringify(idx.stats)}`);

  const agg = new OsmRenamingAggregator();
  // 2. current names of every named way
  let named = 0;
  let namedScoped = 0;
  for await (const c of ndjson<{ n: string; areas: number[]; near?: Array<[number, number]> }>(join(args.dir, 'current-names.ndjson'))) {
    named++;
    const { settlement } = idx.settlementOf(c);
    const nm = c.n ? readStreetName(c.n) : null;
    if (!settlement || !nm) continue;
    agg.addCurrent(settlement.key, nm.key);
    namedScoped++;
  }
  log(`current names: ${named} named ways, ${namedScoped} with a settlement and a parsed name`);

  // 3. streets with former names
  const reasons: Record<string, number> = {};
  const how: Record<string, number> = {};
  const tagUse: Record<string, number> = {};
  let streets = 0;
  let variants = 0;
  let noPairs = 0;
  for await (const s of ndjson<OsmStreet>(join(args.dir, 'streets.ndjson'))) {
    streets++;
    const { pairs, variants: v, current } = osmPairs(s.tags);
    variants += v;
    if (!current || !pairs.length) { noPairs++; continue; }
    const { settlement, reason } = idx.settlementOf(s);
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    if (!settlement) continue;
    how[settlement.how] = (how[settlement.how] ?? 0) + 1;
    for (const p of pairs) {
      const t = p.tag.replace(/:-{0,2}\d{4}[-\d]*/g, ':<date>');
      tagUse[t] = (tagUse[t] ?? 0) + 1;
    }
    agg.add(settlement.key, s.id, settlement.how, pairs);
  }
  const { rows, stats } = agg.rows();
  log(`streets: ${streets} ways with a former-name tag, ${noPairs} without a usable pair, ${variants} spelling/language variants dropped`);
  log(`settlement: ${JSON.stringify(reasons)}; by ${JSON.stringify(how)}`);
  log(`pairs by tag: ${JSON.stringify(tagUse)}`);
  log(`aggregate: ${JSON.stringify(stats)}; ${new Set(rows.map((r) => r.settlementKey)).size} settlements`);

  if (args.dryRun) {
    mkdirSync(args.out as string, { recursive: true });
    await writeCsv(join(args.out as string, 'osm-street-renamings.csv'),
      ['settlement_key', 'old_street_key', 'old_name_sample', 'current_street_key', 'current_name_sample', 'ways', 'how', 'tags', 'until', 'way_id'],
      rows.map((r) => [r.settlementKey, r.oldKey, r.oldName, r.currentKey, r.currentName, r.ways, r.how, r.tags.join(' '), r.until ?? '', r.wayId]));
  }

  if (!args.db) {
    log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s (no DB)`);
    return;
  }

  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435'),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'openreyestr',
    application_name: 'import-osm-street-renamings',
  });
  const client = await pool.connect();
  try {
    await client.query(args.dryRun ? 'BEGIN READ ONLY' : 'BEGIN');
    await client.query("SET LOCAL statement_timeout = '30min'");
    if (args.dryRun) await validate(client, rows, args);
    else await write(client, rows);
    await client.query(args.dryRun ? 'ROLLBACK' : 'COMMIT');
    log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

async function write(client: PoolClient, rows: OsmRenamingRow[]): Promise<void> {
  const del = await client.query("DELETE FROM street_renamings_scoped WHERE source = 'osm'");
  log(`street_renamings_scoped: ${del.rowCount} old osm rows deleted`);
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    const params: unknown[] = [];
    const values = chunk.map((r, j) => {
      params.push(r.settlementKey, r.oldKey, r.oldName, r.currentKey, r.currentName);
      const b = j * 5;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},'osm')`;
    });
    await client.query(
      `INSERT INTO street_renamings_scoped (settlement_key, old_street_key, old_name_sample, current_street_key,
         current_name_sample, source) VALUES ${values.join(',')}`,
      params,
    );
  }
  log(`street_renamings_scoped: ${rows.length} osm rows written`);
}

const coreOf = (k: string) => k.split('|')[1] ?? '';

async function validate(client: PoolClient, rows: OsmRenamingRow[], args: Args): Promise<void> {
  const out = args.out as string;
  const osm = new Map(rows.map((r) => [`${r.settlementKey}#${r.oldKey}`, r]));
  const edr = (await client.query(
    `SELECT settlement_key, old_street_key, old_name_sample, current_street_key, current_name_sample, companies
       FROM street_renamings_scoped WHERE source = 'edr_history'`)).rows;
  const edrKeys = new Set(edr.map((r) => `${r.settlement_key}#${r.old_street_key}`));

  // a. agreement where both sources have a pair for the same settlement + old street
  let both = 0;
  let same = 0;
  let similar = 0;
  const cmp: unknown[][] = [];
  for (const e of edr) {
    const o = osm.get(`${e.settlement_key}#${e.old_street_key}`);
    let status = 'osm_none';
    if (o) {
      both++;
      if (o.currentKey === e.current_street_key) { same++; status = 'agree'; }
      else if (sameStreetName(coreOf(o.currentKey), coreOf(e.current_street_key))) { similar++; status = 'agree_spelling'; }
      else status = 'disagree';
    }
    cmp.push([status, e.settlement_key, e.old_name_sample, e.current_name_sample, e.companies, o?.currentName ?? '', o?.ways ?? '', o?.wayId ?? '']);
  }
  log(`vs edr_history: ${edr.length} edr rows, ${both} with an OSM pair; ${same} same key, ${similar} same name in another spelling, `
    + `${both - same - similar} disagree; agreement ${both ? (((same + similar) / both) * 100).toFixed(1) : '-'}% (strict ${both ? ((same / both) * 100).toFixed(1) : '-'}%)`);
  await writeCsv(join(out, 'osm-vs-edr.csv'),
    ['status', 'settlement_key', 'old_name', 'edr_current', 'edr_companies', 'osm_current', 'osm_ways', 'osm_way_id'], cmp);

  // b. the old global OSM table: edr rows it contradicted (old name known there, other current name)
  const glob = new Set<string>();
  const globOld = new Set<string>();
  const g = await client.query('SELECT COALESCE(current_name_uk, current_name) AS c, old_names FROM street_renamings');
  const gCore = (s: string) => { const r = parseStreetName(s) ?? parseStreetName(`вулиця ${s}`); return r ? streetCoreKey(r.name) : null; };
  for (const r of g.rows) {
    const c = gCore(String(r.c ?? ''));
    if (!c) continue;
    for (const o of r.old_names ?? []) {
      const oc = gCore(String(o));
      if (!oc || oc === c) continue;
      glob.add(`${oc}>${c}`);
      globOld.add(oc);
    }
  }
  const conflicts: unknown[][] = [];
  const res: Record<string, number> = {};
  for (const e of edr) {
    const oc = coreOf(e.old_street_key);
    const cc = coreOf(e.current_street_key);
    if (glob.has(`${oc}>${cc}`) || !globOld.has(oc)) continue;
    const o = osm.get(`${e.settlement_key}#${e.old_street_key}`);
    const status = !o ? 'osm_none'
      : o.currentKey === e.current_street_key || sameStreetName(coreOf(o.currentKey), cc) ? 'resolved_agree' : 'osm_disagree';
    res[status] = (res[status] ?? 0) + 1;
    conflicts.push([status, e.settlement_key, e.old_name_sample, e.current_name_sample, o?.currentName ?? '']);
  }
  log(`old global table contradicted ${conflicts.length} edr rows; with the scoped OSM rows: ${JSON.stringify(res)}`);
  await writeCsv(join(out, 'osm-old-global.csv'), ['status', 'settlement_key', 'old_name', 'edr_current', 'osm_current'], conflicts);

  // c. OSM-only rows: per stratum, the derussification share, and a sample to check by hand
  const only = rows.filter((r) => !edrKeys.has(`${r.settlementKey}#${r.oldKey}`));
  const byStratum = new Map<string, OsmRenamingRow[]>();
  for (const r of only) {
    const s = stratumOf(r.settlementKey);
    let a = byStratum.get(s);
    if (!a) byStratum.set(s, (a = []));
    a.push(r);
  }
  for (const [s, a] of byStratum) {
    log(`osm-only ${s}: ${a.length} rows, ${a.filter(derussification).length} look like 2022-2024 derussification `
      + `(${a.filter((r) => r.until !== null && r.until >= 2022 && r.until <= 2024).length} by a dated tag)`);
  }
  const sample: unknown[][] = [];
  const scale = args.sample / 200;
  for (const [s, , n] of STRATA) {
    for (const r of shuffled(byStratum.get(s) ?? []).slice(0, Math.round(n * scale))) {
      sample.push([s, r.settlementKey, r.oldName, r.currentName, r.ways, r.how, r.tags.join(' '), r.until ?? '', derussification(r) ? 'y' : '',
        `https://www.openstreetmap.org/way/${r.wayId}`, '']);
    }
  }
  await writeCsv(join(out, 'osm-sample.csv'),
    ['stratum', 'settlement_key', 'old_name', 'current_name', 'ways', 'how', 'tags', 'until', 'derussification', 'osm_way', 'verdict'], sample);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
