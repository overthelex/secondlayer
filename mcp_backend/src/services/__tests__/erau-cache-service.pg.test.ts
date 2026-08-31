/**
 * Integration test for ERAUCacheService against a real PostgreSQL.
 *
 * A mocked database cannot validate SQL, and the query-keyed cache relies on
 * `unnest(...) WITH ORDINALITY` plus a bigint[] bind parameter — both of which only
 * fail at the server. Set ERAU_TEST_DATABASE_URL to run; skipped otherwise.
 *
 *   createdb erau_sqlcheck
 *   ERAU_TEST_DATABASE_URL=postgres://localhost/erau_sqlcheck npx jest erau-cache-service.pg
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { ERAUCacheService, ERAULawyer } from '../erau-cache-service';

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('../../utils/redis-client.js', () => ({
  getRedisClient: jest.fn(async () => null),
}));

const DSN = process.env.ERAU_TEST_DATABASE_URL;
const describeIfPg = DSN ? describe : describe.skip;

function lawyer(id: number, surname: string, certat: string): ERAULawyer {
  return {
    id,
    surname,
    firstname: 'Іван',
    middlename: 'Петрович',
    racalc: 'Рада адвокатів Київської області',
    certnum: `21/${id}`,
    certat,
    certcalc: 'Київська обласна КДКА',
  };
}

describeIfPg('ERAUCacheService (real PostgreSQL)', () => {
  let client: Client;
  let service: ERAUCacheService;

  beforeAll(async () => {
    client = new Client({ connectionString: DSN });
    await client.connect();

    const migrations = join(__dirname, '../../migrations');
    for (const file of ['067_erau_lawyers_cache.sql', '193_erau_search_cache.sql']) {
      await client.query(readFileSync(join(migrations, file), 'utf-8'));
    }

    service = new ERAUCacheService({
      query: (text: string, params?: any[]) => client.query(text, params),
    } as any);
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE erau_search_cache');
    await client.query('TRUNCATE erau_lawyers');
  });

  it('round-trips a result set and preserves upstream ordering', async () => {
    // Deliberately not in id order — ERAU orders by registry id, but the cache must
    // reproduce whatever order the proxy received.
    const rows = [
      lawyer(11001, 'Мельник', '2009-03-30 00:00:00'),
      lawyer(8026, 'Мельник', '2004-12-24 00:00:00'),
      lawyer(28541, 'Мельникова', '2026-08-05 00:00:00'),
    ];

    await service.cacheResults('Мельник', rows, 291);
    const got = await service.getBySurname('Мельник');

    expect(got).not.toBeNull();
    expect(got!.map((l) => Number(l.id))).toEqual([11001, 8026, 28541]);
    // A prefix match the old surname-equality lookup could not reproduce.
    expect(got!.map((l) => l.surname)).toContain('Мельникова');
  });

  it('stores the upstream total, not just the row count', async () => {
    await service.cacheResults('Мельник', [lawyer(8026, 'Мельник', '2004-12-24 00:00:00')], 291);
    const { rows } = await client.query('SELECT total FROM erau_search_cache');
    expect(rows[0].total).toBe(291);
  });

  it('normalises the query key so casing and padding hit the same entry', async () => {
    await service.cacheResults('  МЕЛЬНИК ', [lawyer(8026, 'Мельник', '2004-12-24 00:00:00')], 1);
    const got = await service.getBySurname('мельник');
    expect(got).toHaveLength(1);
  });

  it('reproduces a cached empty result set rather than reporting a miss', async () => {
    await service.cacheResults('Неіснуючий', [], 0);
    await expect(service.getBySurname('Неіснуючий')).resolves.toEqual([]);
  });

  it('treats an entry past its TTL as a miss', async () => {
    await service.cacheResults('Мельник', [lawyer(8026, 'Мельник', '2004-12-24 00:00:00')], 1);
    await client.query("UPDATE erau_search_cache SET fetched_at = NOW() - INTERVAL '25 hours'");

    await expect(service.getBySurname('Мельник')).resolves.toBeNull();
  });

  it('still serves an expired entry when the caller allows stale data', async () => {
    await service.cacheResults('Мельник', [lawyer(8026, 'Мельник', '2004-12-24 00:00:00')], 1);
    await client.query("UPDATE erau_search_cache SET fetched_at = NOW() - INTERVAL '25 hours'");

    const got = await service.getBySurname('Мельник', { allowStale: true });
    expect(got).toHaveLength(1);
    expect(Number(got![0].id)).toBe(8026);
  });

  it('replaces a previously truncated result set on refresh', async () => {
    await service.cacheResults('Мельник', [lawyer(8026, 'Мельник', '2004-12-24 00:00:00')], 291);
    await service.cacheResults(
      'Мельник',
      [
        lawyer(8026, 'Мельник', '2004-12-24 00:00:00'),
        lawyer(28541, 'Мельникова', '2026-08-05 00:00:00'),
      ],
      291
    );

    const got = await service.getBySurname('Мельник');
    expect(got).toHaveLength(2);
    const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM erau_search_cache');
    expect(rows[0].n).toBe(1);
  });
});
