/**
 * LEXAI-2181 against a real PostgreSQL: duplicate resolution, the diff-swap, the replace
 * guard, migration 235's catalog config and the one-active-task rule, judged by outcome.
 *
 * Needs a throwaway database; skipped unless IMPORT_TEST_PG_URL is set, e.g.
 *   IMPORT_TEST_PG_URL=postgres://postgres@localhost:55432/postgres npx jest ckan-multifile-import.pg
 * Everything is created in a fresh schema that is dropped afterwards.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Readable } from 'stream';
import { Pool } from 'pg';
import { ImportTaskService } from '../import-task-service';

const PG_URL = process.env.IMPORT_TEST_PG_URL;
const d = PG_URL ? describe : describe.skip;

const schema = `lexai2181_test_${process.pid}`;
const migration = (f: string) => readFileSync(join(__dirname, '..', '..', 'migrations', f), 'utf8');

const base = 'https://data.gov.ua/dataset/41d166e9-d1b8-4a54-8e0a-363b02e2f11d/resource';
const packageShow = {
  success: true,
  result: {
    resources: ['v00', 'v05', 'v07', 'shema'].map(v => ({
      id: v, name: `MVSWantedpassport_${v}.json`, url: `${base}/${v}/download/mvswantedpassport_${v}.json`,
      last_modified: '2026-05-01T01:00:05.496043',
    })),
  },
};

const rec = (id: string, status: string, insertDate: string, extra: Record<string, any> = {}) => ({
  ID: id, OVD: 'ГУНП В М. КИЄВІ', D_SERIES: 'KP', D_NUMBER: id.split('_').pop(),
  D_TYPE: 'ПАСПОРТ ГРОМАДЯНИНА УКРАЇНИ', D_STATUS: status,
  THEFT_DATA: '2012-01-16T00:00:00', INSERT_DATE: `${insertDate}T00:00:00`, ...extra,
});

const files: Record<string, string> = {
  'mvswantedpassport_v00.json': JSON.stringify([
    rec('0101_KP_1', 'X', '2014-01-01'),
    rec('0101_KP_KEEP', 'ВТРАЧЕНО', '2012-01-17'),
    rec('0101_KP_CHG', 'ВИКРАДЕНИЙ', '2012-01-17'),
  ]),
  'mvswantedpassport_v05.json': JSON.stringify([
    rec('0101_KP_1', 'Y', '2015-01-01'),             // latest insert_date -> wins
    rec('0101_KP_TIE', 'P', '2016-01-01'),
    rec('0101_HM_NEW', 'ВТРАЧЕНО', '2016-01-01', { D_SERIES: 'нм' }),
  ]),
  'mvswantedpassport_v07.json': JSON.stringify([
    rec('0101_KP_1', 'Z', '2013-01-01'),             // later file but older -> loses
    rec('0101_KP_TIE', 'Q', '2016-01-01'),           // same insert_date, later record -> wins
  ]),
};

function makeDb(pool: Pool) {
  return {
    query: (text: string, params?: any[]) => pool.query(text, params),
    getPool: () => pool,
    transaction: async <T>(cb: (c: any) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await cb(client);
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

d('CKAN multi-file import on PostgreSQL (LEXAI-2181)', () => {
  let admin: Pool;
  let pool: Pool;
  let svc: any;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: PG_URL, max: 4, options: `-c search_path=${schema}` });
    for (const f of ['110_import_tasks.sql', '117_tier1_opendata_tables.sql', '125_add_missing_sync_sources.sql',
      '235_invalid_passports_ckan_sources.sql']) {
      await pool.query(migration(f));
    }
    await pool.query(migration('235_invalid_passports_ckan_sources.sql')); // idempotent
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(() => {
    svc = new ImportTaskService(makeDb(pool) as any);
    svc.fetchJson = jest.fn(async () => packageShow);
    svc.httpGetStream = jest.fn(async (url: string) => {
      const body = files[url.split('/').pop()!];
      if (body === undefined) throw new Error(`HTTP 404 for ${url}`);
      const buf = Buffer.from(body, 'utf8');
      const chunks: Buffer[] = [];
      for (let i = 0; i < buf.length; i += 5) chunks.push(buf.subarray(i, i + 5));
      return Readable.from(chunks);
    });
    svc.sleep = jest.fn(async () => {});
  });

  async function catalogSource(name: string) {
    const r = await pool.query('SELECT * FROM import_source_catalog WHERE name = $1', [name]);
    const src = r.rows[0];
    return { ...src, source_config: { ...src.source_config, min_files: 3 } };
  }

  const rows = async () => (await pool.query(
    `SELECT id, d_series, d_status, insert_date::text, imported_at FROM opendata_invalid_passports ORDER BY id`,
  )).rows;

  it('migration 235 config is what the importer runs on', async () => {
    const src = (await pool.query(`SELECT source_config FROM import_source_catalog WHERE name = 'invalid_passports'`)).rows[0];
    expect(new RegExp(src.source_config.resource_pattern, 'i').test('mvswantedpassport_v05.json')).toBe(true);
    expect(new RegExp(src.source_config.resource_pattern, 'i').test('mvswantedpassport_shema.json')).toBe(false);
    const f = (await pool.query(`SELECT source_config FROM import_source_catalog WHERE name = 'invalid_passports_foreign'`)).rows[0];
    expect(f.source_config.min_files).toBe(2);
  });

  it('resolves duplicates by outcome and swaps only what changed', async () => {
    await pool.query(`TRUNCATE opendata_invalid_passports`);
    await pool.query(
      `INSERT INTO opendata_invalid_passports (id, ovd, d_series, d_number, d_type, d_status, theft_date, insert_date, imported_at) VALUES
       ('0101_KP_KEEP', 'ГУНП В М. КИЄВІ', 'KP', 'KEEP', 'ПАСПОРТ ГРОМАДЯНИНА УКРАЇНИ', 'ВТРАЧЕНО', '2012-01-16', '2012-01-17', '2020-01-01Z'),
       ('0101_KP_CHG',  'ГУНП В М. КИЄВІ', 'KP', 'CHG',  'ПАСПОРТ ГРОМАДЯНИНА УКРАЇНИ', 'ВТРАЧЕНО', '2012-01-16', '2012-01-17', '2020-01-01Z'),
       ('0101_KP_GONE', 'ГУНП В М. КИЄВІ', 'KP', 'GONE', 'ПАСПОРТ ГРОМАДЯНИНА УКРАЇНИ', 'ВТРАЧЕНО', '2012-01-16', '2012-01-17', '2020-01-01Z')`,
    );
    const src = await catalogSource('invalid_passports');
    await svc.runCkanMultiFileImport(1, src, new AbortController().signal);

    const byId = Object.fromEntries((await rows()).map((r: any) => [r.id, r]));
    expect(Object.keys(byId).sort()).toEqual(['0101_HM_NEW', '0101_KP_1', '0101_KP_CHG', '0101_KP_KEEP', '0101_KP_TIE']);
    expect(byId['0101_KP_1'].d_status).toBe('Y');                 // latest insert_date wins
    expect(byId['0101_KP_1'].insert_date).toBe('2015-01-01');
    expect(byId['0101_KP_TIE'].d_status).toBe('Q');               // tie -> later record
    expect(byId['0101_HM_NEW'].d_series).toBe('HM');              // stored Latin
    expect(byId['0101_KP_CHG'].d_status).toBe('ВИКРАДЕНИЙ');
    expect(new Date(byId['0101_KP_CHG'].imported_at).getUTCFullYear()).toBeGreaterThan(2020); // rewritten
    expect(new Date(byId['0101_KP_KEEP'].imported_at).toISOString()).toBe('2020-01-01T00:00:00.000Z'); // untouched
    const leftovers = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE '%staging%'`, [schema],
    );
    expect(leftovers.rows).toHaveLength(0);
  });

  it('refuses the swap when the load is far below the table, leaving it as is', async () => {
    await pool.query(`TRUNCATE opendata_invalid_passports`);
    await pool.query(
      `INSERT INTO opendata_invalid_passports (id, d_status) SELECT 'X_' || g, 'OLD' FROM generate_series(1, 100) g`,
    );
    const src = await catalogSource('invalid_passports');
    await expect(svc.runCkanMultiFileImport(2, src, new AbortController().signal)).rejects.toThrow(/replace refused/);
    const r = await pool.query(`SELECT count(*)::int n, count(*) FILTER (WHERE d_status = 'OLD')::int old FROM opendata_invalid_passports`);
    expect(r.rows[0]).toEqual({ n: 100, old: 100 });
    const leftovers = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE '%staging%'`, [schema],
    );
    expect(leftovers.rows).toHaveLength(0);
  });

  it('allows one active task per source, also under concurrent starts', async () => {
    await pool.query(`DELETE FROM import_tasks`);
    svc.runImport = jest.fn(() => new Promise(() => {})); // keep the task "running"
    const results = await Promise.allSettled([
      svc.startImport({ sourceName: 'invalid_passports_foreign' }),
      svc.startImport({ sourceName: 'invalid_passports_foreign' }),
      svc.startImport({ sourceName: 'invalid_passports_foreign' }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(2);
    expect(rejected[0].reason.message).toMatch(/вже виконується/);
    const n = await pool.query(`SELECT count(*)::int n FROM import_tasks WHERE source_name = 'invalid_passports_foreign'`);
    expect(n.rows[0].n).toBe(1);
    // A different source is not blocked.
    await expect(svc.startImport({ sourceName: 'invalid_passports' })).resolves.toHaveProperty('taskId');
  });

  it('reaps a running task without progress for a day before starting', async () => {
    await pool.query(`DELETE FROM import_tasks`);
    const old = await pool.query(
      `INSERT INTO import_tasks (source_id, source_name, status, started_at, updated_at)
       SELECT id, name, 'running', NOW() - interval '130 days', NOW() - interval '130 days'
         FROM import_source_catalog WHERE name = 'invalid_passports_foreign' RETURNING id`,
    );
    svc.runImport = jest.fn(() => new Promise(() => {}));
    await expect(svc.startImport({ sourceName: 'invalid_passports_foreign' })).resolves.toHaveProperty('taskId');
    const r = await pool.query(`SELECT status, last_error FROM import_tasks WHERE id = $1`, [old.rows[0].id]);
    expect(r.rows[0].status).toBe('failed');
    expect(r.rows[0].last_error).toMatch(/без прогресу/);
  });
});

