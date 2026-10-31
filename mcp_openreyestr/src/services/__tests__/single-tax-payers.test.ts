import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Pool } from 'pg';
import { REGISTRIES } from '../../config/registries';
import { importCsv } from '../csv-importer';
import { OpenReyestrTools } from '../../api/openreyestr-tools';
import {
  formatActivityCodes,
  formatSingleTaxPayerRow,
  isActivityCodesTruncated,
  normalizeActivityCodes,
  normalizeEdrpou,
  normalizeIsoDate,
  tinLookupCandidates,
} from '../../utils/single-tax';

describe('LEXAI-2159: ЄДРПОУ normalisation', () => {
  it('pads codes that lost their leading zeros', () => {
    expect(normalizeEdrpou('5391695')).toBe('05391695');
    expect(normalizeEdrpou('1744330')).toBe('01744330');
    expect(normalizeEdrpou('32106')).toBe('00032106');
    expect(normalizeEdrpou(' 40263798 ')).toBe('40263798');
  });

  it('leaves RNOKPP and junk alone', () => {
    expect(normalizeEdrpou('3012345678')).toBe('3012345678');
    expect(normalizeEdrpou('253348761')).toBe('253348761');
    expect(normalizeEdrpou('01.11.0')).toBe('01.11.0');
    expect(normalizeEdrpou('')).toBeNull();
    expect(normalizeEdrpou(null)).toBeNull();
  });

  it('looks up both the 8-digit and the zero-stripped stored form', () => {
    expect(tinLookupCandidates('05391695')).toEqual(['05391695', '5391695']);
    expect(tinLookupCandidates('5391695')).toEqual(['05391695', '5391695']);
    expect(tinLookupCandidates(' 01744330 ')).toEqual(['01744330', '1744330']);
    expect(tinLookupCandidates('40263798')).toEqual(['40263798']);
    // a 10-digit RNOKPP with a leading zero is never stripped or padded
    expect(tinLookupCandidates('0123456789')).toEqual(['0123456789']);
    expect(tinLookupCandidates('3012345678')).toEqual(['3012345678']);
  });
});

describe('LEXAI-2159: activity codes', () => {
  it.each([
    ['_47.19, _68.20', ['47.19', '68.20'], 'КВЕД-2010'],
    ['_41.20|_43.21|_43.29', ['41.20', '43.21', '43.29'], 'КВЕД-2010'],
    ['51.39.0; 52.12.0; 51.90.0', ['51.39.0', '52.12.0', '51.90.0'], 'КВЕД-2005'],
    ['18.21.0|51.90.0', ['18.21.0', '51.90.0'], 'КВЕД-2005'],
    ['_46.90I_47.19I_62.01', ['46.90', '47.19', '62.01'], 'КВЕД-2010'],
    ['68.10/68.20/93.16', ['68.10', '68.20', '93.16'], 'КВЕД-2010'],
    ['16,22  16,23  22,23', ['16.22', '16.23', '22.23'], 'КВЕД-2010'],
    ['72,19, 95,21, 46,43 82,99, 26,40,', ['72.19', '95.21', '46.43', '82.99', '26.40'], 'КВЕД-2010'],
    ['_68.20,_47.19', ['68.20', '47.19'], 'КВЕД-2010'],
    ['_78.10_|63.99_|69.10_', ['78.10', '63.99', '69.10'], 'КВЕД-2010'],
    ['70.20.0;71.10.0; 52.62.0.', ['70.20.0', '71.10.0', '52.62.0'], 'КВЕД-2005'],
    ['01.21.0|20.10.0/61.21.0|_46.90', ['01.21.0', '20.10.0', '61.21.0', '46.90'], 'КВЕД-2005/2010'],
    ['01.11.0 вирощування зернових', ['01.11.0'], 'КВЕД-2005'],
    // cut by DPS mid-code: the partial tail is dropped
    ['_47.19|_47.99|_63.99|_6', ['47.19', '47.99', '63.99'], 'КВЕД-2010'],
    ['_68.20, _68.20', ['68.20'], 'КВЕД-2010'],
    // a one-digit class is a code cut off mid-way
    ['68.20, 47.1', ['68.20'], 'КВЕД-2010'],
  ])('%s', (raw, codes, version) => {
    expect(normalizeActivityCodes(raw)).toEqual({ codes, kvedVersion: version });
  });

  it('returns nothing for blanks and dashes', () => {
    expect(normalizeActivityCodes('-')).toEqual({ codes: [], kvedVersion: null });
    expect(normalizeActivityCodes(null)).toEqual({ codes: [], kvedVersion: null });
    expect(formatActivityCodes('')).toBeNull();
    expect(formatActivityCodes('_47.19|_68.20')).toBe('47.19, 68.20');
  });

  it('flags lists DPS cut at ~239 characters', () => {
    const cut = Array.from({ length: 30 }, (_, i) => `_${String(10 + i)}.20`).join(', ') + ',';
    expect(cut.length).toBe(239);
    expect(isActivityCodesTruncated(cut)).toBe(true);
    expect(isActivityCodesTruncated('_47.19, _68.20')).toBe(false);
  });

  it('flags a partial trailing code even below the length limit', () => {
    expect(isActivityCodesTruncated('68.20, 47.1')).toBe(true);
    expect(isActivityCodesTruncated('_47.19|_47.99|_6')).toBe(true);
    expect(isActivityCodesTruncated('70.20.0;71.10.0; 52.62.0.')).toBe(false);
    expect(isActivityCodesTruncated('01.11.0 вирощування зернових')).toBe(false);
    expect(isActivityCodesTruncated('-')).toBe(false);
    expect(isActivityCodesTruncated(null)).toBe(false);
  });
});

describe('LEXAI-2159: dates', () => {
  it('keeps real calendar dates only', () => {
    expect(normalizeIsoDate('2022-02-28')).toBe('2022-02-28');
    expect(normalizeIsoDate('2024-02-29')).toBe('2024-02-29');
    expect(normalizeIsoDate('2022-02-30')).toBeNull();
    expect(normalizeIsoDate('2023-02-29')).toBeNull();
    expect(normalizeIsoDate('2022-13-01')).toBeNull();
    expect(normalizeIsoDate('2022-00-10')).toBeNull();
    expect(normalizeIsoDate('_68.20;;')).toBeNull();
    expect(normalizeIsoDate('')).toBeNull();
  });
});

describe('LEXAI-2159: tool output for rows loaded before the fix', () => {
  it('pads the tin, normalises codes and flags truncation from the raw length', () => {
    const raw = Array.from({ length: 30 }, (_, i) => `_${String(10 + i)}.20`).join(', ') + ',';
    const out = formatSingleTaxPayerRow({
      id: 1, name: "'КОЛЬЧИНСЬКЕ СТ'", tin: '5391695', start_date: '2018-01-01', rate: '5',
      tax_group: '3', activity_codes: raw, activity_codes_truncated: null, end_date: null,
    });
    expect(out.tin).toBe('05391695');
    expect(out.activity_codes).toMatch(/^10\.20, 11\.20, /);
    expect(out.kved_version).toBe('КВЕД-2010');
    expect(out.activity_codes_truncated).toBe(true);
    expect(out.start_date).toBe('2018-01-01');
  });

  it('keeps the stored flag of re-imported rows and drops junk dates', () => {
    const out = formatSingleTaxPayerRow({
      tin: '01744330', activity_codes: '68.20, 47.19', activity_codes_truncated: true,
      start_date: '_68.20;;', end_date: '2019-07-01',
    });
    expect(out.activity_codes_truncated).toBe(true);
    expect(out.start_date).toBeNull();
    expect(out.end_date).toBe('2019-07-01');
  });

  it('searches by both tin forms with one indexable ANY()', async () => {
    const query = jest.fn(async () => ({
      rows: [{ id: 7, name: 'ІВАНИЧІВСЬКЕ СТ', tin: '1744330', activity_codes: '68.20, 47.19, 68.10', activity_codes_truncated: null }],
    }));
    const pool = { query } as unknown as Pool;
    const res = await new OpenReyestrTools(pool).searchSingleTaxPayers({ tin: '01744330' });
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/tin = ANY\(\$1::text\[\]\)/);
    expect(params[0]).toEqual(['01744330', '1744330']);
    expect(res[0]).toMatchObject({ tin: '01744330', kved_version: 'КВЕД-2010', activity_codes_truncated: false });
  });

  it('accepts a numeric tin from JSON clients', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const pool = { query } as unknown as Pool;
    const res = await new OpenReyestrTools(pool).searchSingleTaxPayers({ tin: 5391695 });
    const [, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params[0]).toEqual(['05391695', '5391695']);
    expect(res[0]).toMatchObject({ found: false, query: '5391695' });
  });

  it('passes a 10-digit RNOKPP through unchanged', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const pool = { query } as unknown as Pool;
    await new OpenReyestrTools(pool).searchSingleTaxPayers({ tin: '0123456789' });
    const [, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params[0]).toEqual(['0123456789']);
  });
});

/** Minimal pg Pool stand-in that records every statement. */
function fakePool(indexDefs: string[]) {
  const sql: string[] = [];
  const params: unknown[][] = [];
  const query = jest.fn(async (text: string, values?: unknown[]) => {
    sql.push(text);
    params.push(values ?? []);
    if (text.includes('FROM pg_indexes')) {
      return { rows: indexDefs.map((indexdef, i) => ({ indexname: `idx_${i}`, indexdef })) };
    }
    return { rows: [] };
  });
  const pool = { query, connect: jest.fn(async () => ({ query, release: jest.fn() })) } as unknown as Pool;
  return { pool, sql, params };
}

describe('LEXAI-2159: single_tax_payers import', () => {
  let dir: string;
  let file: string;
  // as pg_indexes reports the index after migration 021
  const TIN_INDEX = 'CREATE UNIQUE INDEX idx_single_tax_tin ON public.single_tax_payers USING btree (tin) NULLS NOT DISTINCT';

  it('refuses to TRUNCATE with the plain UNIQUE index migration 011 created', async () => {
    const { pool, sql } = fakePool([TIN_INDEX.replace(' NULLS NOT DISTINCT', '')]);
    await expect(importCsv(pool, REGISTRIES.single_tax_payers, file, 'reestr_edpod.csv')).rejects.toThrow(/no UNIQUE index/);
    expect(sql.some(s => s.startsWith('TRUNCATE'))).toBe(false);
  });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'edpod-'));
    file = join(dir, 'reestr_edpod.csv');
    // Lines in the shape of the 2022-02-23 DPS file
    writeFileSync(file, [
      'name;tin;data_n;stavka;grup;vd;data_k',
      `"'КОЛЬЧИНСЬКЕ СТ'";5391695;2018-01-01;5;3;"_47.19, _68.20";`,
      '"ПП ""ПКФ СПЕЦСЕРВИС""";31586354;2016-01-01;5;3;"_41.20|_43.21";2019-07-01',
      '"ТОВ ""МП ТОПОЛЯ""";13548194;2016-01-01;5;3;"51.90.0; 26.70.0";',
      '"ІВАНЕНКО ІВАН ІВАНОВИЧ";;2020-01-01;5;2;"_47.11";',
      '"ПП ""ПКФ СПЕЦСЕРВИС""";31586354;2016-01-01;5;3;"_41.20|_43.21";2019-07-01',
    ].join('\n'), 'utf-8');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('points at the newest DPS file and upserts on tin', () => {
    const cfg = REGISTRIES.single_tax_payers;
    expect(cfg.datasetUrl).toContain('reestr-platnukiv-edunogo-podatku-2022_02_23.zip');
    expect(cfg.upsertOnReload).toBe(true);
    expect(cfg.uniqueKey).toBe('tin');
  });

  it('leaves the table untouched when every row is skipped', async () => {
    const onlyFop = join(dir, 'fop-only.csv');
    writeFileSync(onlyFop, [
      'name;tin;data_n;stavka;grup;vd;data_k',
      '"ІВАНЕНКО ІВАН ІВАНОВИЧ";;2020-01-01;5;2;"_47.11";',
      '"ПЕТРЕНКО ПЕТРО";;2021-03-01;5;2;"_47.19";',
    ].join('\n'), 'utf-8');
    const { pool, sql } = fakePool([TIN_INDEX]);
    await expect(importCsv(pool, REGISTRIES.single_tax_payers, onlyFop, 'fop-only.csv'))
      .rejects.toThrow(/no rows to import \(2 skipped\).*untouched/);
    expect(sql.some(s => s.startsWith('TRUNCATE'))).toBe(false);
    expect(sql.some(s => s.startsWith('DROP INDEX'))).toBe(false);
  });

  it('skips rows without a tax number and stores normalised values', async () => {
    const { pool, sql, params } = fakePool([TIN_INDEX]);
    const stats = await importCsv(pool, REGISTRIES.single_tax_payers, file, 'reestr_edpod.csv');

    expect(stats.totalRows).toBe(4); // the FOP row without tin is skipped
    expect(stats.imported).toBe(3); // the duplicate tin collapses
    const i = sql.findIndex(s => s.startsWith('INSERT INTO single_tax_payers'));
    expect(sql[i]).toMatch(/ON CONFLICT \(tin\) DO UPDATE SET/);
    const cols = sql[i].match(/INSERT INTO single_tax_payers \(([^)]+)\)/)![1].split(', ');
    const rows: unknown[][] = [];
    for (let k = 0; k < params[i].length; k += cols.length) rows.push(params[i].slice(k, k + cols.length));
    const by = (r: unknown[], c: string) => r[cols.indexOf(c)];
    expect(rows.map(r => by(r, 'tin'))).toEqual(['05391695', '13548194', '31586354']);
    expect(rows.map(r => by(r, 'activity_codes'))).toEqual(['47.19, 68.20', '51.90.0, 26.70.0', '41.20, 43.21']);
    expect(rows.map(r => by(r, 'activity_codes_truncated'))).toEqual([false, false, false]);
    expect(rows.map(r => by(r, 'end_date'))).toEqual([null, null, '2019-07-01']);
    expect(by(rows[0], 'name')).toBe("'КОЛЬЧИНСЬКЕ СТ'");
  });
});
