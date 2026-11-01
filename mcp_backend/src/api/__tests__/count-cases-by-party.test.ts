/**
 * LEXAI-2177: count_cases_by_party response shape.
 *
 * - by_court listed 30 of 67 courts while the note said its sum equals total_documents;
 *   the rest now goes to by_court_other so the sums agree.
 * - a count whose older years did not fit the time budget says so (incomplete,
 *   pending_years) instead of reading as exact.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { CourtDecisionTools } from '../tools/court-decision-tools';

const build = (counts: any) => {
  const fts = { countByParty: jest.fn(() => Promise.resolve(counts)) };
  const db = { query: jest.fn(() => Promise.resolve({ rows: [] })) };
  const tools = new CourtDecisionTools(
    {} as any, {} as any, {} as any, {} as any, {} as any, db, fts as any, undefined,
  );
  return { tools, fts };
};

const run = async (counts: any, args: any = { party_name: 'Укрексімбанк' }) => {
  const { tools } = build(counts);
  const res = await tools.executeTool('count_cases_by_party', args);
  return JSON.parse((res as any).content[0].text);
};

describe('count_cases_by_party (LEXAI-2177)', () => {
  const courts = Array.from({ length: 67 }, (_, i) => ({ court_code: 1000 + i, count: 67 - i }));
  const total = courts.reduce((s, c) => s + c.count, 0);

  it('puts courts beyond the listed ones into by_court_other so the sums match total_documents', async () => {
    const out = await run({ total, distinct_cases: 317, by_court: courts });
    expect(CourtDecisionTools.BY_COURT_LIMIT).toBe(30);
    expect(out.courts_count).toBe(67);
    expect(out.by_court).toHaveLength(30);
    // Largest first: 1000 (67 docs), 1001 (66) … 1029 (38).
    expect(out.by_court.map((c: any) => c.court_code)).toEqual(Array.from({ length: 30 }, (_, i) => 1000 + i));
    expect(out.by_court_other).toEqual({ courts: 37, documents: 703 });
    const listed = out.by_court.reduce((s: number, c: any) => s + c.count, 0);
    expect(listed + out.by_court_other.documents).toBe(out.total_documents);
    expect(out.note).toContain('by_court_other');
  });

  it('counts documents with no court_code in the remainder bucket', async () => {
    // 10 documents carry no court_code: in total, in no court's count.
    const out = await run({ total: total + 10, distinct_cases: 317, by_court: courts });
    expect(out.by_court_other).toEqual({ courts: 37, documents: 713, unknown_court_documents: 10 });
    const listed = out.by_court.reduce((s: number, c: any) => s + c.count, 0);
    expect(listed + out.by_court_other.documents).toBe(out.total_documents);

    const few = await run({ total: 5, distinct_cases: 2, by_court: [{ court_code: 1, count: 3 }] });
    expect(few.by_court_other).toEqual({ courts: 0, documents: 2, unknown_court_documents: 2 });
  });

  it('omits by_court_other when every court is listed', async () => {
    const out = await run({ total: 3, distinct_cases: 2, by_court: [{ court_code: 1, count: 3 }] });
    expect(out.by_court_other).toBeUndefined();
  });

  it('flags a count with pending years as incomplete and says to repeat the call when cached', async () => {
    const out = await run({ total: 774, distinct_cases: 265, by_court: [], incomplete: true, pending_years: [2025], resumable: true });
    expect(out.incomplete).toBe(true);
    expect(out.resumable).toBe(true);
    expect(out.pending_years).toEqual([2025]);
    expect(out.note).toMatch(/НЕПОВНИЙ.*2025/);
    expect(out.note).toContain('повторіть той самий запит');
  });

  it('does not promise resumption when the cache is unavailable', async () => {
    const out = await run({ total: 774, distinct_cases: 265, by_court: [], incomplete: true, pending_years: [2025], resumable: false });
    expect(out.resumable).toBe(false);
    expect(out.note).not.toContain('повторіть той самий запит');
    expect(out.note).toContain('Кеш недоступний');
  });

  it('a complete count carries no incomplete flag', async () => {
    const out = await run({ total: 1113, distinct_cases: 317, by_court: [] });
    expect(out.incomplete).toBeUndefined();
    expect(out.total_cases).toBe(317);
    expect(out.total_documents).toBe(1113);
  });
});
