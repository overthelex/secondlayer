import { Readable } from 'stream';
import {
  JsonArrayStreamParser, VALUE_TRANSFORMS, packageShowUrl, parseCkanTimestamp, replaceGuardError,
  resourcesUnchangedSince, selectCkanResources, validateTransforms,
} from '../ckan-multifile-import';
import { ImportTaskService, parseSourceIps } from '../import-task-service';
import { normalizePassportSeries } from '../../api/tools/tier1-opendata-tools';
import { normalizePassportSeries as sharedNormalize } from '../../utils/passport-series';

const base = 'https://data.gov.ua/dataset/41d166e9-d1b8-4a54-8e0a-363b02e2f11d/resource';
// Trimmed CKAN package_show response for the re-published МВС dataset (2026-11-01).
const packageShow = {
  success: true,
  result: {
    id: '41d166e9-d1b8-4a54-8e0a-363b02e2f11d',
    name: 'ab09ed00-4f51-4f6c-a2f7-1b2fb118be0f',
    resources: [
      { id: '22fb', name: 'MVSWantedpassport_v05.json', url: `${base}/22fb/download/mvswantedpassport_v05.json`, last_modified: '2026-05-01T01:00:05.496043' },
      { id: '4aa8', name: 'MVSWantedpassport_v07.json', url: `${base}/4aa8/download/mvswantedpassport_v07.json`, last_modified: '2026-04-30T23:32:09.319365' },
      { id: 'bc2f', name: 'MVSWantedpassport_v00.json', url: `${base}/bc2f/download/mvswantedpassport_v00.json`, last_modified: '2026-05-01T00:20:54.467265' },
      { id: '25ce', name: 'MVSWantedPassport_Shema.json', url: `${base}/25ce/download/mvswantedpassport_shema.json`, last_modified: '2019-08-07T14:42:57.935384' },
    ],
  },
};

const rec = (id: string, extra: Record<string, any> = {}) => ({
  ID: id, OVD: 'ГУНП В М. КИЄВІ', D_SERIES: id.split('_')[1] || null, D_NUMBER: id.split('_')[2],
  D_TYPE: 'ПАСПОРТ ГРОМАДЯНИНА УКРАЇНИ', D_STATUS: 'ВТРАЧЕНО',
  THEFT_DATA: '2012-01-16T00:00:00', INSERT_DATE: '2012-01-17T00:00:00', ...extra,
});

describe('CKAN multi-file resolution (LEXAI-2181)', () => {
  it('selects regional data files, drops the schema file, sorts by file name', () => {
    const r = selectCkanResources(packageShow, '^mvswantedpassport_v\\d+\\.json$');
    expect(r.map(x => x.name)).toEqual([
      'MVSWantedpassport_v00.json', 'MVSWantedpassport_v05.json', 'MVSWantedpassport_v07.json',
    ]);
    expect(r[0].url).toBe(`${base}/bc2f/download/mvswantedpassport_v00.json`);
  });

  it('foreign-passport pattern takes every data file but not the schema', () => {
    const pkg = { result: { resources: [
      { id: 'a', name: 'MVSWantedpassport_z.json', url: 'https://x/download/mvswantedpassport_z.json' },
      { id: 'b', name: 'MVSWantedPassport_Shema.json', url: 'https://x/download/mvswantedpassport_shema.json' },
      { id: 'c', name: 'MVSWantedpassport_m.json', url: 'https://x/download/mvswantedpassport_m.json' },
    ] } };
    const r = selectCkanResources(pkg, '^mvswantedpassport_(?!shema)[a-z0-9_]+\\.json$');
    expect(r.map(x => x.id)).toEqual(['c', 'a']);
  });

  it('throws on a response without resources', () => {
    expect(() => selectCkanResources({ success: false }, '.')).toThrow(/no resources/);
  });

  it('builds the package_show URL', () => {
    expect(packageShowUrl('41d166e9-d1b8-4a54-8e0a-363b02e2f11d'))
      .toBe('https://data.gov.ua/api/3/action/package_show?id=41d166e9-d1b8-4a54-8e0a-363b02e2f11d');
  });

  it('skips a run only when every file predates the last successful load', () => {
    const r = selectCkanResources(packageShow, '^mvswantedpassport_v\\d+\\.json$');
    expect(parseCkanTimestamp('2026-05-01T01:00:05.496043')).toBe(Date.parse('2026-05-01T01:00:05.496Z'));
    expect(resourcesUnchangedSince(r, '2026-05-02T00:00:00Z')).toBe(true);
    expect(resourcesUnchangedSince(r, '2026-05-01T00:30:00Z')).toBe(false); // v05 is newer
    expect(resourcesUnchangedSince(r, null)).toBe(false);
    expect(resourcesUnchangedSince([{ ...r[0], last_modified: null }], '2030-01-01T00:00:00Z')).toBe(false);
  });
});

describe('replace guard', () => {
  it('refuses a load well below the current table', () => {
    expect(replaceGuardError(1_000_000, 2_887_669, 0.9)).toMatch(/replace|нове завантаження/);
    expect(replaceGuardError(0, 10, 0.9)).toMatch(/0 записів/);
  });
  it('allows a normal refresh and a first load', () => {
    expect(replaceGuardError(2_889_765, 2_887_669, 0.9)).toBeNull();
    expect(replaceGuardError(2_600_000, 2_887_669, 0.9)).toBeNull();
    expect(replaceGuardError(5, 0, 0.9)).toBeNull();
  });
});

describe('value transforms', () => {
  it('passport_series stores Latin like the search tool expects', () => {
    const t = VALUE_TRANSFORMS.passport_series;
    expect(t('НМ')).toBe('HM');
    expect(t(' km ')).toBe('KM');
    expect(t('СЮ')).toBe('CЮ');
    expect(t(null)).toBeNull();
    expect(t('')).toBeNull();
    expect(normalizePassportSeries).toBe(sharedNormalize); // one implementation for both sides
  });

  it('iso_date keeps the date part and nulls what PostgreSQL would reject', () => {
    const t = VALUE_TRANSFORMS.iso_date;
    expect(t('2012-01-16T00:00:00')).toBe('2012-01-16');
    expect(t('0002-02-01T00:00:00')).toBe('0002-02-01');
    expect(t('0000-03-01T00:00:00')).toBeNull();
    expect(t('2023-02-29T00:00:00')).toBeNull();
    expect(t('2024-02-29T00:00:00')).toBe('2024-02-29');
    expect(t('garbage')).toBeNull();
    expect(t(null)).toBeNull();
  });

  it('rejects an unknown transform name', () => {
    expect(() => validateTransforms({ d_series: 'nope' })).toThrow(/unknown transform/);
    expect(() => validateTransforms({ d_series: 'toString' })).toThrow(/unknown transform/);
    expect(() => validateTransforms({ d_series: 'constructor' })).toThrow(/unknown transform/);
    expect(() => validateTransforms({ d_series: 'passport_series' })).not.toThrow();
  });
});

describe('JsonArrayStreamParser', () => {
  const doc = '﻿[{"ID":"0101_KP_1","OVD":"a } ] \\" {","N":{"x":[1,2]}},\n {"ID":"0101__2","D_SERIES":null}]\n';

  it('parses the whole document in one chunk', () => {
    const p = new JsonArrayStreamParser();
    const out = p.push(doc);
    p.end();
    expect(out).toEqual([
      { ID: '0101_KP_1', OVD: 'a } ] " {', N: { x: [1, 2] } },
      { ID: '0101__2', D_SERIES: null },
    ]);
  });

  it('gives the same result for every split point', () => {
    for (let cut = 1; cut < doc.length; cut++) {
      const p = new JsonArrayStreamParser();
      const out = [...p.push(doc.slice(0, cut)), ...p.push(doc.slice(cut))];
      p.end();
      expect(out.map(r => r.ID)).toEqual(['0101_KP_1', '0101__2']);
    }
  });

  it('parses char by char', () => {
    const p = new JsonArrayStreamParser();
    const out: any[] = [];
    for (const ch of doc) out.push(...p.push(ch));
    p.end();
    expect(out).toHaveLength(2);
  });

  it('detects a truncated download', () => {
    const p = new JsonArrayStreamParser();
    p.push(doc.slice(0, 40));
    expect(() => p.end()).toThrow(/truncated/);
  });

  it('accepts an empty array', () => {
    const p = new JsonArrayStreamParser();
    expect(p.push(' [ ] \n')).toEqual([]);
    p.end();
  });

  // Every malformed document must fail, wherever the chunk border falls.
  const malformed: Array<[string, string]> = [
    ['{"a":1}', 'object instead of array'],
    ['["a"]', 'string element'],
    ['[1]', 'number element'],
    ['[{"a":1},2]', 'number after an object'],
    ['[true]', 'boolean element'],
    ['[null]', 'null element'],
    ['[[]]', 'array element'],
    ['[{"a":1}}', 'object closer for the array'],
    ['[{"a":1}{"b":2}]', 'missing comma'],
    ['[{"a":1},,{"b":2}]', 'double comma'],
    ['[,{"a":1}]', 'leading comma'],
    ['[{"a":1},]', 'trailing comma'],
    ['[{"a":[1}]', 'mismatched bracket inside element'],
    ['[{"a":1}] x', 'data after the array'],
    ['[{"a":1}][]', 'second array'],
    ['[{"a":1}', 'truncated after an element'],
    ['[{"a":1},', 'truncated after a comma'],
  ];
  it.each(malformed)('rejects %s (%s) at every split point', (text) => {
    for (let cut = 0; cut <= text.length; cut++) {
      const p = new JsonArrayStreamParser();
      expect(() => { p.push(text.slice(0, cut)); p.push(text.slice(cut)); p.end(); }).toThrow(/JSON|Unexpected|Expected/);
    }
  });
});

describe('source IPs', () => {
  it('defaults to none (host address) instead of the old AWS ENIs', () => {
    expect(parseSourceIps(undefined)).toEqual([]);
    expect(parseSourceIps('')).toEqual([]);
    expect(parseSourceIps(' 10.0.0.1, 10.0.0.2 ,')).toEqual(['10.0.0.1', '10.0.0.2']);
  });
});

// ---------------------------------------------------------------------------------------
// End-to-end over a fake database: CKAN resolution -> staging -> guard -> swap.

class FakeDb {
  queries: string[] = [];
  txQueries: string[] = [];
  staging: any[][] = [];
  constructor(private currentRows: number, private stagingKeys?: number) {}
  async query(sql: string, params: any[] = []) {
    this.queries.push(sql);
    if (/^INSERT INTO \S+__staging_/.test(sql)) {
      const width = (sql.match(/\(([^)]*)\) VALUES/)![1].split(',').length);
      for (let i = 0; i < params.length; i += width) this.staging.push(params.slice(i, i + width));
      return { rows: [], rowCount: params.length / width };
    }
    if (/count\(DISTINCT/.test(sql)) {
      const n = this.stagingKeys ?? new Set(this.staging.map(r => r[0])).size;
      return { rows: [{ n: String(n) }] };
    }
    if (/SELECT count\(\*\) AS n FROM opendata_/.test(sql)) return { rows: [{ n: String(this.currentRows) }] };
    if (/max\(started_at\)/.test(sql)) return { rows: [{ at: null }] };
    if (/information_schema\.columns/.test(sql)) return { rows: [{ '?column?': 1 }] };
    return { rows: [], rowCount: 0 };
  }
  async transaction(cb: (c: any) => Promise<any>) {
    const client = { query: async (sql: string) => { this.txQueries.push(sql); return { rows: [], rowCount: 7 }; } };
    return cb(client);
  }
}

const passportSource = (overrides: Record<string, any> = {}) => ({
  id: 14, name: 'invalid_passports', title: 'МВС — Недійсні паспорти', source_type: 'json_array',
  source_url: 'https://data.gov.ua/dataset/41d166e9-d1b8-4a54-8e0a-363b02e2f11d',
  target_table: 'opendata_invalid_passports', upsert_sql: null, default_threads_per_ip: 1, rate_limit_ms: 0, enabled: true,
  source_config: {
    ckan_package: '41d166e9-d1b8-4a54-8e0a-363b02e2f11d',
    resource_pattern: '^mvswantedpassport_v\\d+\\.json$',
    min_files: 2, replace: true, unique_key: ['id'], dedup_order: 'insert_date', min_rows_ratio: 0.9,
    mapping: { id: 'ID', ovd: 'OVD', d_series: 'D_SERIES', d_number: 'D_NUMBER', d_type: 'D_TYPE',
      d_status: 'D_STATUS', theft_date: 'THEFT_DATA', insert_date: 'INSERT_DATE' },
    transforms: { d_series: 'passport_series', theft_date: 'iso_date', insert_date: 'iso_date' },
    ...overrides,
  },
});

function run(db: FakeDb, source: any, files: Record<string, string>) {
  const svc = new ImportTaskService(db as any) as any;
  svc.fetchJson = jest.fn(async () => packageShow);
  svc.httpGetStream = jest.fn(async (url: string) => {
    const name = url.split('/').pop()!;
    const body = files[name];
    if (body === undefined) throw new Error(`HTTP 404 for ${url}`);
    // Small chunks so records straddle chunk borders.
    const buf = Buffer.from(body, 'utf8');
    const chunks: Buffer[] = [];
    for (let i = 0; i < buf.length; i += 7) chunks.push(buf.subarray(i, i + 7));
    return Readable.from(chunks);
  });
  svc.sleep = jest.fn(async () => {});
  return { svc, promise: svc.runCkanMultiFileImport(1, source, new AbortController().signal) };
}

describe('runCkanMultiFileImport', () => {
  const files = {
    'mvswantedpassport_v00.json': JSON.stringify([rec('0101_KP_1'), rec('0101_НМ_2', { D_SERIES: 'нм' })]),
    'mvswantedpassport_v05.json': JSON.stringify([rec('0101_ET_3'), rec('0101__4', { D_SERIES: null }), rec('', { ID: null })]),
    'mvswantedpassport_v07.json': JSON.stringify([rec('0101_KP_1', { INSERT_DATE: '2014-01-01T00:00:00' })]),
  };

  it('loads every regional file into staging and swaps in one transaction', async () => {
    const db = new FakeDb(4);
    const { svc, promise } = run(db, passportSource(), files);
    await promise;
    expect(svc.httpGetStream).toHaveBeenCalledTimes(3); // schema file not downloaded
    expect(db.staging).toHaveLength(5); // 6 records, one without ID skipped
    const series = db.staging.map(r => r[2]);
    expect(series).toContain('HM'); // Cyrillic input stored Latin
    expect(series).toContain(null);
    const isoOrNull = (v: any) => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v);
    expect(db.staging.every(r => isoOrNull(r[6]) && isoOrNull(r[7]))).toBe(true); // theft_date, insert_date
    expect(db.staging.map(r => r[7])).toContain('2014-01-01');
    expect(db.txQueries[0]).toMatch(/statement_timeout/);
    expect(db.txQueries[1]).toMatch(/pg_advisory_xact_lock\(hashtext\('import_swap:'/);
    expect(db.txQueries[2]).toMatch(/DELETE FROM opendata_invalid_passports t WHERE NOT EXISTS/);
    // Outcome of the duplicate rule is checked on a real database in ckan-multifile-import.pg.test.ts.
    expect(db.txQueries[3]).toMatch(/SELECT DISTINCT ON \(id\).*ORDER BY id, insert_date DESC NULLS LAST, _ord DESC/s);
    expect(db.txQueries[3]).toMatch(/ON CONFLICT \(id\) DO UPDATE SET .*IS DISTINCT FROM/s);
    expect(db.queries.some(q => /DROP TABLE IF EXISTS opendata_invalid_passports__staging_1$/.test(q))).toBe(true);
  });

  it('refuses the swap when the new load is far below the current table', async () => {
    const db = new FakeDb(2_887_669);
    const { promise } = run(db, passportSource(), files);
    await expect(promise).rejects.toThrow(/replace refused/);
    expect(db.txQueries).toHaveLength(0); // target untouched
    expect(db.queries[db.queries.length - 1]).toMatch(/DROP TABLE IF EXISTS .*__staging_1/);
  });

  it('refuses when fewer files than min_files match', async () => {
    const db = new FakeDb(4);
    const { svc, promise } = run(db, passportSource({ min_files: 20 }), files);
    await expect(promise).rejects.toThrow(/3 файлів/);
    expect(svc.httpGetStream).not.toHaveBeenCalled();
    expect(db.txQueries).toHaveLength(0);
  });

  it('fails without touching the target when a file stays unavailable', async () => {
    const db = new FakeDb(4);
    const { svc, promise } = run(db, passportSource(), { ...files, 'mvswantedpassport_v05.json': undefined as any });
    await expect(promise).rejects.toThrow(/v05.*404/);
    expect(svc.httpGetStream).toHaveBeenCalledTimes(1 + 3); // v00 ok, v05 retried 3x
    expect(db.txQueries).toHaveLength(0);
  });

  it('fails on a truncated file', async () => {
    const db = new FakeDb(4);
    const truncated = files['mvswantedpassport_v05.json'].slice(0, 60);
    const { promise } = run(db, passportSource(), { ...files, 'mvswantedpassport_v05.json': truncated });
    await expect(promise).rejects.toThrow(/truncated/);
    expect(db.txQueries).toHaveLength(0);
  });
});
