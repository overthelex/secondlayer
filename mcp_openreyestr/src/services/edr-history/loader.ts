/**
 * Load one ЄДР dump (one or more files of the same date) into edr_hist as a snapshot.
 * Port of forensic app/registers/ua_edr.py (Stager, finalize, _fold_history).
 *
 * 1. Stream every subject into TEMP staging tables (batched INSERT ... SELECT FROM unnest).
 * 2. Pick one subject per code (a code repeats when cancelled duplicates sit next to the live
 *    record): the most alive status, then the latest registration, then the highest RECORD.
 * 3. In ONE transaction for both kinds (uo, fsu): upsert company/founder/beneficiary/head and
 *    fold the staged values into edr_hist.history, then record the snapshot rows. A failed load
 *    leaves nothing behind; a kind already loaded for the date is not folded again. A run cut at
 *    --limit (or dryRun) is rolled back.
 *
 * History fold, for snapshot S and field F, with prev/next = the loaded snapshots of this kind
 * just before/after S that publish F (edr_hist.snapshot.fields). A run with last_snapshot NULL is
 * open (lasts through the latest snapshot publishing F), so the weekly newest-snapshot load only
 * writes changes:
 *   a. a run spanning S whose value is absent in S is split into [first, prev] and [next, last]
 *      (only when S publishes F at all); a2. when S is the newest, open runs of absent values close
 *      at prev;
 *   b. a present value whose runs end at prev and start at next: the two runs are joined;
 *   c. else the closed run ending at prev is extended to S, or d. the run starting at next starts at S;
 *   e. else a new run, open when S is the newest.
 * So snapshots can be loaded in any order.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { entryRows, EdrSubject, HISTORY_FIELDS, historyValues, statusRank } from './entries';
import { uaMatchKey } from './norm';
import { DumpFormat, newReadStats, readDump, ReadStats } from './records';

export interface LoadOptions {
  snapshot: string;            // YYYY-MM-DD
  source: string;
  files: string[];
  statementTimeout?: string;   // default '60min'
  batchSize?: number;          // staged subjects per INSERT batch, default 5000
  limit?: number;              // stop after N subjects (smoke tests); implies dryRun
  dryRun?: boolean;            // run everything, then roll back: nothing is recorded
  log?: (msg: string) => void;
}

export interface LoadResult {
  snapshot: string;
  skipped?: string;
  dryRun?: boolean;            // rolled back, nothing recorded
  subjects: Record<'uo' | 'fsu', number>;
  noCode: number;
  formats: Record<DumpFormat, number>;
  fields: Record<'uo' | 'fsu', string[]>;
  members: string[];
  skippedMembers: string[];
  seconds: { read: number; fold: number };
}

const STG: Record<string, Array<[string, string]>> = {
  stg_subject: [['record', 'text'], ['edrpou', 'text'], ['kind', 'text'], ['rank', 'int'], ['name', 'text'],
    ['name_latn', 'text'], ['short_name', 'text'], ['legal_form', 'text'], ['status', 'text'], ['address', 'text'],
    ['kved', 'text'], ['registered_on', 'date'], ['capital', 'text']],
  stg_founder: [['record', 'text'], ['edrpou', 'text'], ['entry_hash', 'text'], ['raw', 'text'], ['kind', 'text'],
    ['name', 'text'], ['name_latn', 'text'], ['code', 'text'], ['country', 'text'], ['country_code', 'text'],
    ['contribution', 'text'], ['contribution_uah', 'numeric']],
  stg_beneficiary: [['record', 'text'], ['edrpou', 'text'], ['entry_hash', 'text'], ['raw', 'text'], ['name', 'text'],
    ['name_latn', 'text'], ['country', 'text'], ['country_code', 'text'], ['influence', 'text'], ['share', 'text'],
    ['reason', 'text']],
  stg_head: [['record', 'text'], ['edrpou', 'text'], ['entry_hash', 'text'], ['raw', 'text'], ['source', 'text'],
    ['name', 'text'], ['name_latn', 'text'], ['role', 'text'], ['role_class', 'text'], ['appointed_on', 'date']],
  stg_hist: [['record', 'text'], ['edrpou', 'text'], ['kind', 'text'], ['field', 'text'], ['value_hash', 'text'],
    ['value', 'text']],
};

type Row = Array<string | number | null>;

class Stager {
  rows: Record<string, Row[]> = Object.fromEntries(Object.keys(STG).map(t => [t, []]));
  subjects = { uo: 0, fsu: 0 };
  fields = { uo: new Set<string>(), fsu: new Set<string>() };
  private seq = 0;

  constructor(private client: PoolClient, private batch: number) {}

  async init(): Promise<void> {
    for (const [t, cols] of Object.entries(STG)) {
      await this.client.query(`DROP TABLE IF EXISTS ${t}`);
      await this.client.query(`CREATE TEMP TABLE ${t} (${cols.map(([c, ty]) => `${c} ${ty}`).join(', ')})`);
    }
  }

  add(s: EdrSubject): void {
    const rec = s.record || `o${++this.seq}`;
    const ed = s.edrpou;
    this.subjects[s.kind]++;
    const { founders, beneficiaries, heads } = entryRows(s);
    this.rows.stg_subject.push([rec, ed, s.kind, statusRank(s.status), s.name, uaMatchKey(s.name) || null, s.short_name,
      s.legal_form, s.status, s.address, s.kved, s.registered_on, s.capital]);
    for (const f of founders) {
      this.rows.stg_founder.push([rec, ed, f.hash, f.raw, f.kind, f.name, f.name_latn, f.code, f.country, f.country_code,
        f.contribution, f.contribution_uah]);
    }
    for (const b of beneficiaries) {
      this.rows.stg_beneficiary.push([rec, ed, b.hash, b.raw, b.name, b.name_latn, b.country, b.country_code, b.influence,
        b.share, b.reason]);
    }
    for (const h of heads) {
      this.rows.stg_head.push([rec, ed, h.hash, h.raw, h.source, h.name, h.name_latn, h.role, h.role_class, h.appointed_on]);
    }
    for (const v of historyValues(s, founders, beneficiaries, heads)) {
      this.fields[s.kind].add(v.field);
      this.rows.stg_hist.push([rec, ed, s.kind, v.field, v.value_hash, v.value]);
    }
  }

  get pending(): number {
    return this.rows.stg_subject.length;
  }

  async flush(): Promise<void> {
    for (const [t, rows] of Object.entries(this.rows)) {
      if (!rows.length) continue;
      const cols = STG[t];
      // one array parameter per column: no 65535-parameter limit, one round trip per batch
      const arrays = cols.map((_, i) => rows.map(r => (r[i] === null || r[i] === undefined ? null : r[i])));
      await this.client.query(
        `INSERT INTO ${t} (${cols.map(c => c[0]).join(', ')})
         SELECT * FROM unnest(${cols.map(([, ty], i) => `$${i + 1}::${ty}[]`).join(', ')})`,
        arrays,
      );
      this.rows[t] = [];
    }
  }

  get batchSize(): number {
    return this.batch;
  }
}

// chunks of the code range, so each statement joins a slice: [None,'01'), ['01','02'), ..., ['99', None)
const BOUNDS: Array<string | null> = [null, ...Array.from({ length: 99 }, (_, i) => String(i + 1).padStart(2, '0')), null];

function chunk(col: string, lo: string | null, hi: string | null): string {
  const parts = [lo ? `${col} >= '${lo}'` : '', hi ? `${col} < '${hi}'` : ''].filter(Boolean);
  return parts.join(' AND ') || 'TRUE';
}

const CO_COLS = ['kind', 'record_id', 'name', 'name_latn', 'short_name', 'legal_form', 'status', 'address', 'kved',
  'capital', 'registered_on'];
const KEEP_OLD = new Set(['address', 'kved']);   // left out of the current dumps: keep the last published value
const F_COLS = ['kind', 'name', 'name_latn', 'code', 'country', 'country_code', 'contribution', 'contribution_uah'];
const B_COLS = ['name', 'name_latn', 'country', 'country_code', 'influence', 'share', 'reason'];
const H_COLS = ['source', 'name', 'name_latn', 'role', 'role_class', 'appointed_on'];

/** SET list: the newer snapshot wins column by column; first_seen / last_seen widen. */
function newer(table: string, cols: string[]): string {
  const sets = cols.map(c => {
    let nw = `EXCLUDED.${c}`;
    let old = `${table}.${c}`;
    if (KEEP_OLD.has(c)) { nw = `coalesce(EXCLUDED.${c}, ${table}.${c})`; old = `coalesce(${table}.${c}, EXCLUDED.${c})`; }
    return `${c} = CASE WHEN EXCLUDED.last_seen >= ${table}.last_seen THEN ${nw} ELSE ${old} END`;
  });
  return [...sets, `first_seen = LEAST(${table}.first_seen, EXCLUDED.first_seen)`,
    `last_seen = GREATEST(${table}.last_seen, EXCLUDED.last_seen)`].join(', ');
}

async function prepare(c: PoolClient): Promise<void> {
  for (const t of Object.keys(STG)) await c.query(`ANALYZE ${t}`);
  // fresh statistics: right after the first loads the planner would take these tables for empty
  for (const t of ['history', 'company', 'founder', 'beneficiary', 'head']) await c.query(`ANALYZE edr_hist.${t}`);
  await c.query(`DROP TABLE IF EXISTS stg_pick`);
  await c.query(`CREATE TEMP TABLE stg_pick AS
                 SELECT DISTINCT ON (edrpou) edrpou, record FROM stg_subject
                 ORDER BY edrpou, rank, registered_on DESC NULLS LAST, record DESC`);
  await c.query(`CREATE UNIQUE INDEX ON stg_pick (edrpou, record)`);
  await c.query(`CREATE INDEX ON stg_hist (edrpou, field, value_hash)`);
  for (const t of ['stg_subject', 'stg_founder', 'stg_beneficiary', 'stg_head']) await c.query(`CREATE INDEX ON ${t} (edrpou, record)`);
  await c.query(`ANALYZE stg_pick`);
}

const KEY = 'h.edrpou = t.edrpou AND h.field = t.field AND h.value_hash = t.value_hash';

async function finalizeKind(c: PoolClient, kind: 'uo' | 'fsu', S: string, fields: string[], meta: {
  source: string; file: string; md5: string; format: string; subjects: number;
}, log: (m: string) => void): Promise<void> {
  {
    await c.query(`DROP TABLE IF EXISTS stg_nb`);
    await c.query(
      `CREATE TEMP TABLE stg_nb AS
       SELECT f AS field,
              (SELECT max(snapshot_date) FROM edr_hist.snapshot WHERE kind = $1 AND snapshot_date < $2::date AND f = ANY(fields)) AS prev,
              (SELECT min(snapshot_date) FROM edr_hist.snapshot WHERE kind = $1 AND snapshot_date > $2::date AND f = ANY(fields)) AS next,
              (SELECT max(snapshot_date) FROM edr_hist.snapshot WHERE kind = $1 AND snapshot_date <> $2::date AND f = ANY(fields)) AS latest,
              f = ANY($3::text[]) AS carried
       FROM unnest($4::text[]) AS f`,
      [kind, S, fields, [...HISTORY_FIELDS]],
    );
    await c.query(`DROP TABLE IF EXISTS stg_h`);
    await c.query(
      `CREATE TEMP TABLE stg_h AS
       SELECT DISTINCT ON (h.edrpou, h.field, h.value_hash) h.edrpou, h.field, h.value_hash, h.value
       FROM stg_hist h JOIN stg_pick p USING (edrpou, record) WHERE h.kind = $1`, [kind]);
    await c.query(`CREATE UNIQUE INDEX ON stg_h (edrpou, field, value_hash)`);
    await c.query(`ANALYZE stg_h`);

    const a = [S, kind];
    for (let i = 0; i + 1 < BOUNDS.length; i++) {
      const [lo, hi] = [BOUNDS[i], BOUNDS[i + 1]];
      const ws = chunk('s.edrpou', lo, hi);
      await c.query(
        `INSERT INTO edr_hist.company (edrpou, ${CO_COLS.join(', ')}, first_seen, last_seen)
         SELECT s.edrpou, s.kind, CASE WHEN s.record LIKE 'o%' THEN NULL ELSE s.record END, s.name, s.name_latn,
                s.short_name, s.legal_form, s.status, s.address, s.kved, s.capital, s.registered_on, $1::date, $1::date
         FROM stg_subject s JOIN stg_pick p USING (edrpou, record) WHERE s.kind = $2 AND ${ws}
         ON CONFLICT (edrpou) DO UPDATE SET ${newer('edr_hist.company', CO_COLS)}`, a);
      for (const [table, stg, cols] of [['founder', 'stg_founder', F_COLS], ['beneficiary', 'stg_beneficiary', B_COLS],
        ['head', 'stg_head', H_COLS]] as Array<[string, string, string[]]>) {
        await c.query(
          `INSERT INTO edr_hist.${table} (edrpou, entry_hash, raw, ${cols.join(', ')}, first_seen, last_seen)
           SELECT DISTINCT ON (s.edrpou, s.entry_hash) s.edrpou, s.entry_hash, s.raw, ${cols.map(x => `s.${x}`).join(', ')}, $1::date, $1::date
           FROM ${stg} s JOIN stg_pick p USING (edrpou, record)
           JOIN stg_subject x ON x.edrpou = s.edrpou AND x.record = s.record AND x.kind = $2
           WHERE ${ws} ORDER BY s.edrpou, s.entry_hash
           ON CONFLICT (edrpou, entry_hash) DO UPDATE SET
             ${cols.map(x => `${x} = CASE WHEN EXCLUDED.last_seen >= edr_hist.${table}.last_seen THEN EXCLUDED.${x} ELSE edr_hist.${table}.${x} END`).join(', ')},
             first_seen = LEAST(edr_hist.${table}.first_seen, EXCLUDED.first_seen),
             last_seen = GREATEST(edr_hist.${table}.last_seen, EXCLUDED.last_seen)`, a);
      }
      if (i % 20 === 19) log(`  ${kind}: entries chunk ${i + 1}/${BOUNDS.length - 1}`);
    }
    const t0 = Date.now();
    const steps = await foldHistory(c, kind, S);
    log(`  ${kind}: history fold ${((Date.now() - t0) / 1000).toFixed(0)}s, rows ${JSON.stringify(steps)}`);
    await c.query(
      `INSERT INTO edr_hist.snapshot (kind, snapshot_date, source, file, md5, format, subjects, fields)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)`,
      [kind, S, meta.source, meta.file, meta.md5, meta.format, meta.subjects, fields]);
  }
}

/**
 * Fold the staged values (stg_h) of snapshot S into edr_hist.history. One statement per step over
 * the whole kind, with nested loops disabled: these are bulk set operations (millions of rows on
 * both sides) and the planner, misled by dates outside the column statistics, otherwise picked
 * nested loops that rescanned history per staged row.
 *
 * A run with last_snapshot NULL is open: it lasts through the latest loaded snapshot that
 * publishes the field (see view edr_hist.history_runs). Loading the newest snapshot therefore
 * writes only what changed: runs of values that disappeared are closed (a2), new values are
 * inserted (e). Unchanged values are not touched. Steps a-d only do work for a snapshot loaded
 * between two already loaded ones (historical backfill).
 */
export async function foldHistory(c: PoolClient, kind: string, S: string): Promise<Record<string, number>> {
  const a = [S, kind];
  const n: Record<string, number> = {};
  const run = async (step: string, sql: string, params: unknown[] = a) => {
    const r = await c.query(sql, params);
    n[step] = r.rowCount ?? 0;
  };
  await c.query('SET LOCAL enable_nestloop = off');
  const between = (await c.query(`SELECT bool_or(next IS NOT NULL) AS b FROM stg_nb WHERE carried`)).rows[0].b === true;
  const absent = `NOT EXISTS (SELECT 1 FROM stg_h t WHERE ${KEY})`;
  if (between) {
    // a. a run spanning S whose value is absent in S is split into [first, prev] and [next, last]
    await run('split', `WITH sp AS (
         SELECT h.edrpou, h.field, h.value_hash, h.value, h.kind, h.first_snapshot, h.last_snapshot, n.prev, n.next
         FROM edr_hist.history h JOIN stg_nb n ON n.field = h.field AND n.carried
         WHERE h.kind = $2 AND h.first_snapshot < $1::date
           AND (h.last_snapshot > $1::date OR (h.last_snapshot IS NULL AND n.latest > $1::date)) AND ${absent}),
       ins AS (INSERT INTO edr_hist.history (edrpou, field, value_hash, value, kind, first_snapshot, last_snapshot)
               SELECT edrpou, field, value_hash, value, kind, next, last_snapshot FROM sp)
       UPDATE edr_hist.history h SET last_snapshot = sp.prev FROM sp
       WHERE h.edrpou = sp.edrpou AND h.field = sp.field AND h.value_hash = sp.value_hash
         AND h.first_snapshot = sp.first_snapshot`);
  }
  // a2. S is the newest snapshot of the field: close the open runs of values absent in S
  await run('close', `UPDATE edr_hist.history h SET last_snapshot = n.prev FROM stg_nb n
     WHERE n.field = h.field AND n.carried AND n.next IS NULL AND n.prev < $1::date
       AND h.kind = $2 AND h.last_snapshot IS NULL AND h.first_snapshot <= n.prev AND ${absent}`);
  if (between) {
    // b. present: join the run that ends at prev with the one that starts at next
    await run('merge', `WITH pairs AS (
         SELECT t.edrpou, t.field, t.value_hash, p.first_snapshot AS pf, x.first_snapshot AS xf, x.last_snapshot AS xl
         FROM stg_h t JOIN stg_nb n USING (field)
         JOIN edr_hist.history p ON p.edrpou = t.edrpou AND p.field = t.field AND p.value_hash = t.value_hash AND p.last_snapshot = n.prev
         JOIN edr_hist.history x ON x.edrpou = t.edrpou AND x.field = t.field AND x.value_hash = t.value_hash AND x.first_snapshot = n.next),
       del AS (DELETE FROM edr_hist.history h USING pairs q
               WHERE h.edrpou = q.edrpou AND h.field = q.field AND h.value_hash = q.value_hash AND h.first_snapshot = q.xf)
       UPDATE edr_hist.history h SET last_snapshot = q.xl FROM pairs q
       WHERE h.edrpou = q.edrpou AND h.field = q.field AND h.value_hash = q.value_hash AND h.first_snapshot = q.pf`, []);
  }
  const covered = (alias: string) => `EXISTS (SELECT 1 FROM edr_hist.history y WHERE y.edrpou = ${alias}.edrpou
      AND y.field = ${alias}.field AND y.value_hash = ${alias}.value_hash AND y.first_snapshot <= $1::date
      AND (y.last_snapshot >= $1::date OR y.last_snapshot IS NULL))`;
  // c. extend the closed run that ends at prev (open when S is the newest), or d. start the run
  //    that starts at next at S
  await run('extend', `UPDATE edr_hist.history h SET last_snapshot = CASE WHEN n.next IS NULL THEN NULL ELSE $1::date END, value = t.value
     FROM stg_h t JOIN stg_nb n USING (field)
     WHERE ${KEY} AND h.kind = $2 AND h.last_snapshot = n.prev AND NOT ${covered('t')}`);
  if (between) {
    await run('prepend', `UPDATE edr_hist.history h SET first_snapshot = $1::date
       FROM stg_h t JOIN stg_nb n USING (field)
       WHERE ${KEY} AND h.kind = $2 AND h.first_snapshot = n.next AND NOT ${covered('t')}`);
  }
  // the newest wording of an open run (formats differ between eras): only rows whose text changed
  await run('reword', `UPDATE edr_hist.history h SET value = t.value
     FROM stg_h t JOIN stg_nb n USING (field)
     WHERE ${KEY} AND h.kind = $2 AND n.next IS NULL AND h.last_snapshot IS NULL AND h.first_snapshot < $1::date
       AND h.value IS DISTINCT FROM t.value`);
  // e. otherwise a new run: open when S is the newest snapshot of the field, else [S, S]
  await run('new', `INSERT INTO edr_hist.history (edrpou, field, value_hash, value, kind, first_snapshot, last_snapshot)
     SELECT t.edrpou, t.field, t.value_hash, t.value, $2, $1::date, CASE WHEN n.next IS NULL THEN NULL ELSE $1::date END
     FROM stg_h t JOIN stg_nb n USING (field)
     WHERE NOT ${covered('t')}`);
  return n;
}

export function md5File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('md5');
    fs.createReadStream(file, { highWaterMark: 1 << 22 })
      .on('data', d => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

class LimitReached extends Error {}

export async function loadEdrSnapshot(pool: Pool, opts: LoadOptions): Promise<LoadResult> {
  const log = opts.log || ((m: string) => console.log(m));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.snapshot)) throw new Error(`snapshot must be YYYY-MM-DD, got ${opts.snapshot}`);
  const S = opts.snapshot;
  const result: LoadResult = {
    snapshot: S, subjects: { uo: 0, fsu: 0 }, noCode: 0, formats: { subject: 0, record: 0, row: 0 },
    fields: { uo: [], fsu: [] }, members: [], skippedMembers: [], seconds: { read: 0, fold: 0 },
  };
  if (opts.limit !== undefined && !(Number.isInteger(opts.limit) && opts.limit > 0)) {
    throw new Error(`limit must be a positive integer, got ${opts.limit}`);
  }
  // a load cut at --limit is not the snapshot: it is measured, then rolled back
  const dryRun = Boolean(opts.dryRun || opts.limit);
  const c = await pool.connect();
  let locked = false;
  try {
    // session settings of a pooled connection: reset in finally
    await c.query(`SET statement_timeout = '${(opts.statementTimeout || '60min').replace(/'/g, '')}'`);
    await c.query(`SET work_mem = '512MB'`);
    const lock = await c.query(`SELECT pg_try_advisory_lock(hashtext('edr_hist_loader')) AS ok`);
    if (!lock.rows[0].ok) throw new Error('another edr_hist load is running');
    locked = true;
    // per kind: a date may hold UO and FSU from separate loads
    const loaded = new Set<string>((await c.query(`SELECT kind FROM edr_hist.snapshot WHERE snapshot_date = $1::date`, [S])).rows.map(r => r.kind));
    if (loaded.has('uo') && loaded.has('fsu')) {
      result.skipped = `snapshot ${S} already loaded (uo, fsu)`;
      log(result.skipped);
      return result;
    }

    const md5s: string[] = [];
    for (const f of opts.files) md5s.push(await md5File(f));

    const t0 = Date.now();
    const st = new Stager(c, opts.batchSize || 5000);
    await st.init();
    const stats: ReadStats = newReadStats();
    let n = 0;
    const sink = (s: EdrSubject) => {
      if (opts.limit && n >= opts.limit) throw new LimitReached();
      st.add(s);
      n++;
      if (n % 100000 === 0) log(`  read ${n} subjects`);
    };
    const drain = async () => { if (st.pending >= st.batchSize) await st.flush(); };
    for (const f of opts.files) {
      log(`Reading ${path.basename(f)}`);
      try {
        await readDump(f, sink, drain, stats);
      } catch (e) {
        if (!(e instanceof LimitReached)) throw e;
        log(`  stopped at --limit ${opts.limit}`);
        break;
      }
    }
    await st.flush();
    result.seconds.read = (Date.now() - t0) / 1000;
    Object.assign(result, { noCode: stats.noCode, formats: stats.formats, members: stats.members, skippedMembers: stats.skippedMembers });
    result.subjects = { ...st.subjects };
    log(`Read: uo ${st.subjects.uo}, fsu ${st.subjects.fsu}, without code ${stats.noCode} in ${result.seconds.read.toFixed(0)}s`);

    const t1 = Date.now();
    await prepare(c);
    const format = (Object.entries(stats.formats) as Array<[DumpFormat, number]>).filter(([, v]) => v > 0).map(([k]) => k).join(',');
    const kinds = (['uo', 'fsu'] as const).filter(k => st.subjects[k] && !loaded.has(k));
    const already = (['uo', 'fsu'] as const).filter(k => st.subjects[k] && loaded.has(k));
    if (already.length) log(`  ${already.join(', ')} of ${S} already loaded: not folded again`);
    if (!kinds.length) {
      result.skipped = `snapshot ${S} already loaded (${[...loaded].join(', ')})`;
      log(result.skipped);
      return result;
    }
    // both kinds in one transaction: a failed load leaves nothing behind
    await c.query('BEGIN');
    try {
      for (const kind of kinds) {
        const fields = [...st.fields[kind]].sort();
        result.fields[kind] = fields;
        log(`Folding ${kind} (${st.subjects[kind]} subjects; fields: ${fields.join(', ')})`);
        await finalizeKind(c, kind, S, fields, {
          source: opts.source, file: opts.files.map(f => path.basename(f)).join(', '), md5: md5s.join(','),
          format, subjects: st.subjects[kind],
        }, log);
      }
      await c.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
    result.seconds.fold = (Date.now() - t1) / 1000;
    if (dryRun) result.dryRun = true;
    log(`Snapshot ${S} ${dryRun ? 'folded and rolled back (dry run)' : 'loaded'} in ${(result.seconds.read + result.seconds.fold).toFixed(0)}s (fold ${result.seconds.fold.toFixed(0)}s)`);
    return result;
  } finally {
    await c.query('RESET statement_timeout').catch(() => undefined);
    await c.query('RESET work_mem').catch(() => undefined);
    if (locked) await c.query(`SELECT pg_advisory_unlock(hashtext('edr_hist_loader'))`).catch(() => undefined);
    for (const t of [...Object.keys(STG), 'stg_pick', 'stg_nb', 'stg_h']) await c.query(`DROP TABLE IF EXISTS ${t}`).catch(() => undefined);
    c.release();
  }
}
