import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ARMA_DELETE_STALE_SQL, ARMA_UPSERT_SQL, importArmaFile, staleDeleteBlocker } from '../arma-import';

const HEADER = '{"results":[{"columns":[{"name":"ID","type":"CLOB"}],"items":';
const item = (id: number, extra = '') =>
  `{"id":${id},"description":"Автомобіль","docnum":"757/${id}/19-к","decisiondate":"01.02.2019","numerdr":"12014100030013137","props_1":"Найменування суду: Печерський районний суд міста Києва"${extra}}`;

let dir: string;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arma-import-test-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function writeFile(name: string, lines: string[]): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

/** Mock pool: table had `before` rows; upserts insert everything; count by run id returns what was upserted. */
function mockPool(before: number) {
  let upserted = 0;
  const query = jest.fn(async (sql: string, params?: any[]) => {
    if (sql === ARMA_UPSERT_SQL) {
      const rows = JSON.parse(params![0]);
      upserted += rows.length;
      return { rows: rows.map(() => ({ is_insert: true })) };
    }
    if (sql.includes('WHERE import_run_id = $1')) return { rows: [{ n: String(upserted) }] };
    if (sql.startsWith('SELECT COUNT(*) AS n FROM arma_assets')) return { rows: [{ n: String(before) }] };
    if (sql === ARMA_DELETE_STALE_SQL) return { rows: [], rowCount: 7 };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return { pool: { query } as any, query };
}

describe('importArmaFile (LEXAI-2161)', () => {
  it('stamps rows with the run id and deletes other runs by id, never by timestamp', async () => {
    const file = writeFile('complete.json', [HEADER, '[', item(1), ',' + item(2), ',' + item(3, ',"actionincomesum":583526,51'), ']}]}']);
    const { pool, query } = mockPool(3);
    const stats = await importArmaFile(pool, file, { sourceUrl: 'u', runId: 'run-1', batchSize: 2 });

    expect(stats).toMatchObject({ items: 3, inserted: 3, seen: 3, parseErrors: 0, complete: true, staleDeleted: 7, staleKeptReason: null });
    const upserts = query.mock.calls.filter(([sql]) => sql === ARMA_UPSERT_SQL);
    expect(upserts).toHaveLength(2);
    for (const [, params] of upserts) expect(params![1]).toBe('run-1');
    expect(ARMA_UPSERT_SQL).toMatch(/import_run_id = EXCLUDED\.import_run_id/);

    const del = query.mock.calls.filter(([sql]) => sql === ARMA_DELETE_STALE_SQL);
    expect(del).toEqual([[ARMA_DELETE_STALE_SQL, ['run-1']]]);
    expect(ARMA_DELETE_STALE_SQL).toBe('DELETE FROM arma_assets WHERE import_run_id IS DISTINCT FROM $1');
    expect(ARMA_DELETE_STALE_SQL).not.toMatch(/updated_at|now\(\)|timestamp/i);
  });

  it('keeps stale rows when the file has no closing marker (truncated at a line boundary)', async () => {
    const file = writeFile('truncated.json', [HEADER, '[', item(1), ',' + item(2)]);
    const { pool, query } = mockPool(2);
    const stats = await importArmaFile(pool, file, { sourceUrl: 'u', runId: 'run-2' });
    expect(stats.complete).toBe(false);
    expect(stats.staleKeptReason).toMatch(/closing/);
    expect(query.mock.calls.some(([sql]) => sql === ARMA_DELETE_STALE_SQL)).toBe(false);
  });

  it('keeps stale rows when a line cannot be parsed', async () => {
    const file = writeFile('broken.json', [HEADER, '[', item(1), ',{"id":2,"description":"oops', ']}]}']);
    const { pool, query } = mockPool(1);
    const stats = await importArmaFile(pool, file, { sourceUrl: 'u', runId: 'run-3' });
    expect(stats).toMatchObject({ parseErrors: 1, complete: true, staleDeleted: null });
    expect(query.mock.calls.some(([sql]) => sql === ARMA_DELETE_STALE_SQL)).toBe(false);
  });

  it('keeps stale rows when the run saw too few rows', async () => {
    const file = writeFile('small.json', [HEADER, '[', item(1), ']}]}']);
    const { pool, query } = mockPool(1000);
    const stats = await importArmaFile(pool, file, { sourceUrl: 'u', runId: 'run-4' });
    expect(stats.staleKeptReason).toMatch(/below 0.8 of 1000/);
    expect(query.mock.calls.some(([sql]) => sql === ARMA_DELETE_STALE_SQL)).toBe(false);
  });

  it('does not treat a pretty-printed "columns" array as items', async () => {
    const file = writeFile('pretty.json', [
      '{',
      '  "results": [',
      '    {',
      '      "columns": [',
      '        {"name":"ID","type":"CLOB"},',
      '        {"name":"DESCRIPTION","type":""}',
      '      ],',
      '      "items":',
      '[',
      item(1),
      ',' + item(2),
      ']',
      '    }',
      '  ]',
      '}',
    ]);
    const { pool, query } = mockPool(2);
    const stats = await importArmaFile(pool, file, { sourceUrl: 'u', runId: 'run-5' });
    expect(stats).toMatchObject({ items: 2, parseErrors: 0, complete: true });
    const [, params] = query.mock.calls.find(([sql]) => sql === ARMA_UPSERT_SQL)!;
    expect(JSON.parse(params![0]).map((r: any) => r.asset_id)).toEqual(['1', '2']);
  });

  it('accepts "items": [ on one line', async () => {
    const file = writeFile('inline.json', ['{"results":[{"columns":[', '{"name":"ID"}', '],"items": [', item(7), ']}]}']);
    const { pool } = mockPool(1);
    const stats = await importArmaFile(pool, file, { sourceUrl: 'u', runId: 'run-6' });
    expect(stats).toMatchObject({ items: 1, complete: true, parseErrors: 0 });
  });

  it('stops without deleting when the file has no "items" key', async () => {
    const file = writeFile('noitems.json', ['{"results":[{"columns":', '[', '{"name":"ID"}', ']', '}]}']);
    const { pool, query } = mockPool(5);
    const stats = await importArmaFile(pool, file, { sourceUrl: 'u', runId: 'run-7' });
    expect(stats).toMatchObject({ items: 0, complete: false });
    expect(query.mock.calls.some(([sql]) => sql === ARMA_UPSERT_SQL || sql === ARMA_DELETE_STALE_SQL)).toBe(false);
  });

  it('staleDeleteBlocker reports failed batches', () => {
    expect(staleDeleteBlocker({ complete: true, parseErrors: 0, batchErrors: 1, seen: 10, before: 10 })).toMatch(/failed batches/);
    expect(staleDeleteBlocker({ complete: true, parseErrors: 0, batchErrors: 0, seen: 10, before: 10 })).toBeNull();
  });
});
