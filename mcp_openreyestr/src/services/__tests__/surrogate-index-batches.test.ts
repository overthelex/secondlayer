import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Pool } from 'pg';
import type { RegistryConfig } from '../../config/registries';
import { importXml } from '../generic-xml-importer';
import { importCsv } from '../csv-importer';

/**
 * LEXAI-2129: the gen_<n> surrogate used to be the record's index inside its batch,
 * so every batch reused gen_1..gen_<batch size> and, through ON CONFLICT, each batch's
 * keyless rows overwrote the previous batch's. It must be numbered file-wide.
 */

// Several batches on every path: XML 2000, CSV upsert 1000, CSV huge 5000.
const RECORDS = 11000;

function mockPool() {
  const surrogates: string[] = [];
  const capture = jest.fn(async (_sql: string, values?: unknown[]) => {
    for (const v of values ?? []) if (typeof v === 'string' && /^gen_\d+$/.test(v)) surrogates.push(v);
    return { rows: [], rowCount: 0 };
  });
  const client = { query: capture, release: jest.fn() };
  const pool = { query: capture, connect: jest.fn(async () => client) } as unknown as Pool;
  return { pool, surrogates };
}

function config(over: Partial<RegistryConfig>): RegistryConfig {
  return {
    id: 999,
    name: 'test_registry',
    title: 'test',
    format: 'xml',
    encoding: 'utf-8',
    datasetUrl: '',
    zipFileName: '',
    innerFileName: '',
    tableName: 'test_table',
    uniqueKey: 'code',
    recordPath: 'DATA.RECORD',
    fieldMap: { code: 'MISSING_TAG', name: 'NAME' },
    updateFrequency: 'weekly',
    sizeCategory: 'small',
    ...over,
  } as RegistryConfig;
}

function expectFileWideUnique(surrogates: string[]) {
  expect(surrogates).toHaveLength(RECORDS);
  expect(new Set(surrogates).size).toBe(RECORDS);
  const nums = surrogates.map((s) => Number(s.slice(4))).sort((a, b) => a - b);
  expect(nums[0]).toBe(1);
  expect(nums[nums.length - 1]).toBe(RECORDS);
}

describe('LEXAI-2129: gen_<n> surrogates are unique across batches', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lexai2129-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  function writeXml(): string {
    const body = Array.from({ length: RECORDS }, (_, i) => `<RECORD><NAME>n${i}</NAME></RECORD>`).join('');
    const file = join(dir, 'records.xml');
    writeFileSync(file, `<?xml version="1.0" encoding="utf-8"?><DATA>${body}</DATA>`);
    return file;
  }

  function writeCsv(): string {
    const file = join(dir, 'records.csv');
    writeFileSync(file, ['CODE;NAME', ...Array.from({ length: RECORDS }, (_, i) => `;n${i}`)].join('\n'));
    return file;
  }

  it('XML in-memory import', async () => {
    const { pool, surrogates } = mockPool();
    await importXml(pool, config({ sizeCategory: 'small' }), writeXml(), 'records.xml');
    expectFileWideUnique(surrogates);
  });

  it('XML streaming import', async () => {
    const { pool, surrogates } = mockPool();
    await importXml(pool, config({ sizeCategory: 'large' }), writeXml(), 'records.xml');
    expectFileWideUnique(surrogates);
  });

  it('CSV upsert import', async () => {
    const { pool, surrogates } = mockPool();
    await importCsv(pool, config({ format: 'csv', sizeCategory: 'small', fieldMap: { code: 'CODE', name: 'NAME' } }), writeCsv(), 'records.csv');
    expectFileWideUnique(surrogates);
  });

  it('CSV huge (TRUNCATE + INSERT) import', async () => {
    const { pool, surrogates } = mockPool();
    await importCsv(pool, config({ format: 'csv', sizeCategory: 'huge', fieldMap: { code: 'CODE', name: 'NAME' } }), writeCsv(), 'records.csv');
    expectFileWideUnique(surrogates);
  });
});
