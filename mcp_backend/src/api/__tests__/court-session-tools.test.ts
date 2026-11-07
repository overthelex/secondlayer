/**
 * search_court_hearing_schedule reads two tables: the published schedule
 * (opendata_court_schedule, the coming weeks) and the archive of past hearings
 * (court_sessions, 30M+). Until 11.2026 only the schedule was read, so a case whose
 * hearings had already happened came back "no hearings" (200/2129/24 had four in the
 * archive). These tests pin the two-source read, the merge, and the rule that the
 * archive is only queried through its indexes.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { CourtSessionTools, mergeHearings, hearingDay } from '../tools/court-session-tools.js';

type QueryCall = { sql: string; params?: any[] };

const scheduleRow = (over: Partial<Record<string, any>> = {}) => ({
  hearing_date: '12.12.2026 10:00', court_name: 'Перший апеляційний адміністративний суд',
  case_number: '200/2129/24', judges: 'Сіваченко І.В.', court_room: '8',
  case_involved: 'ПАТ «Часівоярський вогнетривкий комбінат»', case_description: 'апеляційна скарга', ...over,
});
const archiveRow = (over: Partial<Record<string, any>> = {}) => ({
  hearing_date: '26.09.2024 11:00', court_name: 'Перший апеляційний адміністративний суд',
  case_number: '200/2129/24', judges: 'Головуючий суддя: Сіваченко Ігор Вікторович', court_room: '8',
  case_involved: 'Позивач: ПАТ «Часівоярський вогнетривкий комбінат»', case_description: null, ...over,
});

describe('CourtSessionTools.search_court_hearing_schedule', () => {
  let calls: QueryCall[];
  let tool: CourtSessionTools;

  const makeDb = (responder: (sql: string, params?: any[]) => any) => ({
    query: jest.fn((sql: string, params?: any[]) => {
      calls.push({ sql, params });
      return Promise.resolve(responder(sql, params));
    }),
  });
  const bySource = (sql: string) => (sql.includes('FROM court_sessions') ? 'archive' : sql.includes('FROM opendata_court_schedule') ? 'schedule' : 'other');
  const parse = (r: any) => JSON.parse(r?.content[0].text || '{}');

  beforeEach(() => {
    calls = [];
  });

  it('reads the schedule AND the archive for a case number and merges them newest first', async () => {
    const db = makeDb((sql) => ({ rows: bySource(sql) === 'archive' ? [archiveRow(), archiveRow({ hearing_date: '12.09.2024 11:00' })] : [scheduleRow()] }));
    tool = new CourtSessionTools({} as any, db);

    const res = parse(await tool.executeTool('search_court_hearing_schedule', { query: '200/2129/24', limit: 10 }));

    const sources = calls.map((c) => bySource(c.sql)).sort();
    expect(sources).toEqual(['archive', 'schedule']);
    const archive = calls.find((c) => bySource(c.sql) === 'archive')!;
    expect(archive.sql).toMatch(/WHERE case_number = \$1/);
    expect(archive.params?.[0]).toBe('200/2129/24');
    expect(archive.sql).toMatch(/ORDER BY session_date DESC NULLS LAST/);

    expect(res.sessions_found).toBe(3);
    expect(res.sources).toEqual({ schedule: 1, archive: 2 });
    expect(res.opendata_results.map((r: any) => [r.hearing_date, r.source])).toEqual([
      ['12.12.2026 10:00', 'schedule'],
      ['26.09.2024 11:00', 'archive'],
      ['12.09.2024 11:00', 'archive'],
    ]);
  });

  it('answers from the archive alone when the schedule has nothing (hearings already held)', async () => {
    const db = makeDb((sql) => ({ rows: bySource(sql) === 'archive' ? [archiveRow()] : [] }));
    tool = new CourtSessionTools({} as any, db);

    const res = parse(await tool.executeTool('search_court_hearing_schedule', { case_number: '200/2129/24' }));

    expect(res.sessions_found).toBe(1);
    expect(res.opendata_results[0].source).toBe('archive');
    expect(res.message).toBeUndefined();
  });

  it('keeps one row per hearing when both sources hold it, and the schedule row wins', async () => {
    const same = { hearing_date: '26.09.2024 11:00', court_name: 'Перший апеляційний адміністративний суд' };
    const db = makeDb((sql) => ({
      rows: bySource(sql) === 'archive'
        ? [archiveRow(same)]
        : [scheduleRow({ ...same, court_room: '8', case_description: 'розгляд' })],
    }));
    tool = new CourtSessionTools({} as any, db);

    const res = parse(await tool.executeTool('search_court_hearing_schedule', { query: '200/2129/24' }));

    expect(res.sessions_found).toBe(1);
    expect(res.opendata_results[0].source).toBe('schedule');
    expect(res.opendata_results[0].case_description).toBe('розгляд');
  });

  it('searches the archive by participant through the tsvector index, not ILIKE', async () => {
    const db = makeDb(() => ({ rows: [] }));
    tool = new CourtSessionTools({} as any, db);

    await tool.executeTool('search_court_hearing_schedule', { participant: 'Часівоярський', court_name: 'Перший апеляційний' });

    const archive = calls.find((c) => bySource(c.sql) === 'archive')!;
    expect(archive.sql).toMatch(/to_tsvector\('simple', involved_parties\) @@ plainto_tsquery\('simple', \$1\)/);
    expect(archive.sql).toMatch(/to_tsvector\('simple', court_name\) @@ plainto_tsquery\('simple', \$2\)/);
    expect(archive.sql).not.toMatch(/involved_parties ILIKE/);
    expect(archive.params?.slice(0, 2)).toEqual(['Часівоярський', 'Перший апеляційний']);
  });

  it('does not touch the archive for a judge-only search (no index on judge_name)', async () => {
    const db = makeDb(() => ({ rows: [] }));
    tool = new CourtSessionTools({} as any, db);

    await tool.executeTool('search_court_hearing_schedule', { judge: 'Сіваченко' });

    expect(calls.map((c) => bySource(c.sql))).toEqual(['schedule']);
  });

  it('applies judge and dates as extra predicates on an anchored archive search', async () => {
    const db = makeDb(() => ({ rows: [] }));
    tool = new CourtSessionTools({} as any, db);

    await tool.executeTool('search_court_hearing_schedule', {
      case_number: '200/2129/24', judge: 'Сіваченко', date_from: '2024-01-01', date_to: '2024-12-31',
    });

    const archive = calls.find((c) => bySource(c.sql) === 'archive')!;
    expect(archive.sql).toMatch(/judge_name ILIKE \$2/);
    expect(archive.sql).toMatch(/session_date >= \$3::date/);
    expect(archive.sql).toMatch(/session_date <= \$4::date/);
    expect(archive.params).toEqual(['200/2129/24', '%Сіваченко%', '2024-01-01', '2024-12-31', 50]);
  });

  it('still answers from the schedule when the archive table errors (deployments without it)', async () => {
    const db = makeDb((sql) => {
      if (bySource(sql) === 'archive') throw new Error('relation "court_sessions" does not exist');
      return { rows: [scheduleRow()] };
    });
    (db.query as any) = jest.fn((sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (bySource(sql) === 'archive') return Promise.reject(new Error('relation "court_sessions" does not exist'));
      return Promise.resolve({ rows: [scheduleRow()] });
    });
    tool = new CourtSessionTools({} as any, db);

    const res = parse(await tool.executeTool('search_court_hearing_schedule', { query: '200/2129/24' }));

    expect(res.sessions_found).toBe(1);
    expect(res.sources).toEqual({ schedule: 1, archive: 0 });
  });
});

describe('mergeHearings / hearingDay', () => {
  it('parses both date shapes the tables use', () => {
    expect(hearingDay('26.09.2024 11:00')).toBe('2024-09-26');
    expect(hearingDay('2024-09-26T00:00:00.000Z')).toBe('2024-09-26');
    expect(hearingDay(null)).toBe('');
  });

  it('orders newest day first and dedups on case, day and court regardless of spacing/case', () => {
    const merged = mergeHearings(
      [{ hearing_date: '01.02.2025 09:00', case_number: '1/2/25', court_name: 'Суд А' }],
      [
        { hearing_date: '01.02.2025 09:00', case_number: '1 /2/25', court_name: 'суд а' },
        { hearing_date: '03.03.2025 09:00', case_number: '1/2/25', court_name: 'Суд А' },
      ],
    );
    expect(merged.map((r) => [r.hearing_date, r.source])).toEqual([
      ['03.03.2025 09:00', 'archive'],
      ['01.02.2025 09:00', 'schedule'],
    ]);
  });
});
