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
    expect(out.courts_count).toBe(67);
    expect(out.by_court).toHaveLength(CourtDecisionTools.BY_COURT_LIMIT);
    expect(out.by_court_other.courts).toBe(67 - CourtDecisionTools.BY_COURT_LIMIT);
    const listed = out.by_court.reduce((s: number, c: any) => s + c.count, 0);
    expect(listed + out.by_court_other.documents).toBe(out.total_documents);
    expect(out.note).toContain('by_court_other');
  });

  it('omits by_court_other when every court is listed', async () => {
    const out = await run({ total: 3, distinct_cases: 2, by_court: [{ court_code: 1, count: 3 }] });
    expect(out.by_court_other).toBeUndefined();
  });

  it('flags a count with pending years as incomplete and says to repeat the call', async () => {
    const out = await run({ total: 774, distinct_cases: 265, by_court: [], incomplete: true, pending_years: [2025] });
    expect(out.incomplete).toBe(true);
    expect(out.pending_years).toEqual([2025]);
    expect(out.note).toMatch(/НЕПОВНИЙ.*2025/);
    expect(out.note).toContain('повторіть той самий запит');
  });

  it('a complete count carries no incomplete flag', async () => {
    const out = await run({ total: 1113, distinct_cases: 317, by_court: [] });
    expect(out.incomplete).toBeUndefined();
    expect(out.total_cases).toBe(317);
    expect(out.total_documents).toBe(1113);
  });
});
