import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import iconv from 'iconv-lite';
import type { Pool } from 'pg';
import { REGISTRIES } from '../../config/registries';
import { importCsv } from '../csv-importer';
import {
  dedupeAndSortByKey,
  indexDefColumns,
  isUniqueKeyIndex,
  rowKey,
  uniqueKeyColumns,
} from '../unique-key-load';

// indexdef exactly as pg_indexes reports the index from migration 020
const KEY_INDEX_DEF =
  'CREATE UNIQUE INDEX debtors_natural_key_uniq ON public.debtors USING btree ' +
  '(proceeding_number, debtor_name, debtor_edrpou) NULLS NOT DISTINCT';
const DEBTOR_KEY = ['proceeding_number', 'debtor_name', 'debtor_edrpou'];

describe('LEXAI-2130: unique-key helpers', () => {
  it('debtors opts into upsert-on-reload with the natural key', () => {
    expect(REGISTRIES.debtors.upsertOnReload).toBe(true);
    expect(uniqueKeyColumns(REGISTRIES.debtors)).toEqual(DEBTOR_KEY);
    expect(REGISTRIES.enforcement_proceedings.upsertOnReload).toBeUndefined();
  });

  it('parses the column list of an indexdef', () => {
    expect(indexDefColumns(KEY_INDEX_DEF)).toEqual(DEBTOR_KEY);
    expect(indexDefColumns('CREATE INDEX i ON public.t USING btree ("Col_a", b)')).toEqual(['Col_a', 'b']);
    expect(indexDefColumns("CREATE INDEX i ON public.t USING gin (to_tsvector('simple'::regconfig, debtor_name))")).toBeNull();
    expect(indexDefColumns('CREATE UNIQUE INDEX i ON public.t USING btree (lower(debtor_name))')).toBeNull();
    expect(indexDefColumns('CREATE INDEX i ON t (a)')).toBeNull();
  });

  it('recognises only a non-partial UNIQUE NULLS NOT DISTINCT index on exactly the key', () => {
    expect(isUniqueKeyIndex(KEY_INDEX_DEF, DEBTOR_KEY)).toBe(true);
    // the 004 constraint's index: NULLs distinct, NULL-edrpou rows never conflict
    expect(isUniqueKeyIndex(
      'CREATE UNIQUE INDEX debtors_proceeding_number_debtor_name_debtor_edrpou_key ON public.debtors USING btree (proceeding_number, debtor_name, debtor_edrpou)',
      DEBTOR_KEY
    )).toBe(false);
    expect(isUniqueKeyIndex(KEY_INDEX_DEF.replace('UNIQUE ', ''), DEBTOR_KEY)).toBe(false);
    expect(isUniqueKeyIndex(
      'CREATE UNIQUE INDEX k ON public.debtors USING btree (proceeding_number, debtor_name)',
      DEBTOR_KEY
    )).toBe(false);
    expect(isUniqueKeyIndex(`${KEY_INDEX_DEF} WHERE (debtor_edrpou IS NOT NULL)`, DEBTOR_KEY)).toBe(false);
    expect(isUniqueKeyIndex(
      'CREATE INDEX idx_debtors_proceeding ON public.debtors USING btree (proceeding_number)',
      ['proceeding_number']
    )).toBe(false);
  });

  it('treats NULLs as equal and NULL as different from an empty string', () => {
    const k = (e: unknown) => rowKey({ proceeding_number: '1', debtor_name: 'A', debtor_edrpou: e }, DEBTOR_KEY);
    expect(k(null)).toBe(k(undefined));
    expect(k(null)).not.toBe(k(''));
    expect(k('12345678')).not.toBe(k('1234567'));
  });

  it('collapses duplicates (last wins) and sorts by key', () => {
    const { rows, duplicates } = dedupeAndSortByKey(
      [{ k: 'b', v: 1 }, { k: 'a', v: 2 }, { k: 'b', v: 3 }],
      r => r.k
    );
    expect(rows).toEqual([{ k: 'a', v: 2 }, { k: 'b', v: 3 }]);
    expect(duplicates).toBe(1);
  });
});

/** Minimal pg Pool stand-in that records every statement. */
function fakePool(indexDefs: string[], failMultiRowInsert = false) {
  const sql: string[] = [];
  const params: unknown[][] = [];
  const query = jest.fn(async (text: string, values?: unknown[]) => {
    sql.push(text);
    params.push(values ?? []);
    if (failMultiRowInsert && text.startsWith('INSERT INTO') && /\),\s*\(/.test(text)) {
      throw new Error('simulated multi-row failure');
    }
    if (text.includes('FROM pg_indexes')) {
      return { rows: indexDefs.map((indexdef, i) => ({ indexname: `idx_${i}`, indexdef })) };
    }
    if (text.includes('FROM pg_constraint')) return { rows: [] };
    return { rows: [] };
  });
  const pool = {
    query,
    connect: jest.fn(async () => ({ query, release: jest.fn() })),
  } as unknown as Pool;
  return { pool, sql, params };
}

describe('LEXAI-2130: debtors reload upserts against the natural key', () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'debtors-'));
    file = join(dir, 'erb.csv');
    const csv = [
      'VP_ORDERNUM,DEBTOR_NAME,DEBTOR_CODE,PUBLISHER,EMP_FULL_FIO,ORG_NAME,EMP_PHONE_NUM,EMAIL_ADDR,VD_CAT',
      '53420132,ТОВ ОДІСТЕК,35991936,Суд,Мельничук,ВДВС,1,a@b.c,стягнення',
      '53420132,ТОВ ОДІСТЕК,35991936,Суд,Мельничук,ВДВС,1,a@b.c,стягнення',
      '81645862,Кравченко Ганна,,Суд,Петренко,ВДВС,2,c@d.e,аліменти',
      '81645862,Кравченко Ганна,,Суд,Петренко,ВДВС,2,c@d.e,аліменти',
      '70000001,Іваненко Іван,,Суд,Сидоренко,ВДВС,3,e@f.g,штраф',
    ].join('\n');
    writeFileSync(file, iconv.encode(csv, 'windows-1251'));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses to TRUNCATE when the key index is missing', async () => {
    const { pool, sql } = fakePool([
      'CREATE INDEX idx_debtors_proceeding ON public.debtors USING btree (proceeding_number)',
    ]);
    await expect(importCsv(pool, REGISTRIES.debtors, file, 'erb.csv')).rejects.toThrow(/no UNIQUE index/);
    expect(sql.some(s => s.startsWith('TRUNCATE'))).toBe(false);
  });

  it('keeps the key index, upserts with ON CONFLICT and collapses duplicate rows', async () => {
    const { pool, sql, params } = fakePool([
      KEY_INDEX_DEF,
      'CREATE INDEX idx_debtors_proceeding ON public.debtors USING btree (proceeding_number)',
    ]);
    const stats = await importCsv(pool, REGISTRIES.debtors, file, 'erb.csv');

    expect(sql.some(s => s.startsWith('TRUNCATE debtors'))).toBe(true);
    // the key index is never dropped; the plain one is dropped and recreated
    expect(sql.some(s => /DROP (INDEX|CONSTRAINT).*idx_0\b/.test(s))).toBe(false);
    expect(sql).toContain('DROP INDEX IF EXISTS idx_1');

    const inserts = sql
      .map((s, i) => ({ s, p: params[i] }))
      .filter(x => x.s.startsWith('INSERT INTO debtors'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].s).toMatch(/ON CONFLICT \(proceeding_number, debtor_name, debtor_edrpou\) DO UPDATE SET/);
    expect(inserts[0].s).not.toMatch(/raw_data/);

    // 5 source rows, 3 distinct keys; individuals keep debtor_edrpou NULL
    expect(stats.totalRows).toBe(5);
    expect(stats.imported).toBe(3);
    const cols = inserts[0].s.match(/INSERT INTO debtors \(([^)]+)\)/)![1].split(', ');
    const rows: unknown[][] = [];
    for (let i = 0; i < inserts[0].p.length; i += cols.length) rows.push(inserts[0].p.slice(i, i + cols.length));
    const edrpou = cols.indexOf('debtor_edrpou');
    const proc = cols.indexOf('proceeding_number');
    expect(rows.map(r => r[proc])).toEqual(['53420132', '70000001', '81645862']);
    expect(rows.map(r => r[edrpou])).toEqual(['35991936', null, null]);
  });

  it('row-by-row fallback upserts the same deduped, key-sorted rows', async () => {
    const { pool, sql, params } = fakePool([KEY_INDEX_DEF], true);
    const stats = await importCsv(pool, REGISTRIES.debtors, file, 'erb.csv');

    const single = sql
      .map((s, i) => ({ s, p: params[i] }))
      .filter(x => x.s.trimStart().startsWith('INSERT INTO debtors') && !/\),\s*\(/.test(x.s));
    expect(single).toHaveLength(3);
    single.forEach(x => expect(x.s).toMatch(/ON CONFLICT \(proceeding_number, debtor_name, debtor_edrpou\) DO UPDATE/));
    const cols = single[0].s.match(/INSERT INTO debtors \(([^)]+)\)/)![1].split(', ');
    const proc = cols.indexOf('proceeding_number');
    expect(single.map(x => x.p[proc])).toEqual(['53420132', '70000001', '81645862']);
    expect(stats.imported).toBe(3);
    expect(stats.errors).toBe(2);
  });
});
