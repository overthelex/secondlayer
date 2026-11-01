/**
 * LEXAI-2176: case numbers typed without (or with) the procedural suffix.
 *
 * search_court_decisions {mode:'structured', cause_num:'352/923/16'} returned 0 and
 * get_court_decision {case_number:'352/923/16'} said «Рішення не знайдено в ЄДРСР», while
 * the case has 9 documents stored as 352/923/16-ц. get_case_documents_chain already
 * resolved the suffix; these two tools did a bare `cause_num = $1` and never asked.
 *
 * Contract: the exact spelling always wins; a variant is tried only when the exact lookup
 * found nothing, and the response names the variant that matched.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { causeNumRangeEnd, lookupWithCauseNumberFallback, resolveCauseNumber } from '../tool-utils';
import { EdsrUnifiedSearchTool } from '../tools/edrsr-unified-search-tool.js';
import { CourtDecisionTools } from '../tools/court-decision-tools';

const STORED = '352/923/16-ц';
const BARE = '352/923/16';

const DECISION_TEXT =
  'ПОСТАНОВА ІМЕНЕМ УКРАЇНИ. Верховний Суд у складі колегії суддів Касаційного цивільного суду ' +
  'розглянув у порядку письмового провадження касаційну скаргу. Керуючись статтями 400, 409, 410 ' +
  'ЦПК України, Верховний Суд постановив касаційну скаргу залишити без задоволення. '.repeat(3);

/**
 * A tiny corpus, keyed by stored cause_num. It answers the way Postgres would:
 * - the case-index probe (`cause_num = ANY($1)`) and the sibling range probe
 *   (`cause_num >= $1 AND cause_num < $2 AND cause_num LIKE $3`) against the index;
 * - structured COUNT/data queries apply EVERY `d.<col> = $n` predicate in the SQL, so a
 *   retry that drops or misplaces a filter changes the answer instead of passing silently.
 */
type Doc = { doc_id: number; cause_num: string; justice_kind: number; judgment_code: number };

function makeCorpusDb(stored: Record<string, number> = { [STORED]: 9 }) {
  const docs: Doc[] = Object.entries(stored).flatMap(([cause_num, n], k) =>
    Array.from({ length: n }, (_, i) => ({ doc_id: 72073973 + k * 100 + i, cause_num, justice_kind: 1, judgment_code: 2 })),
  );
  const calls: Array<{ sql: string; params: any[] }> = [];

  const applyFilters = (sql: string, params: any[]) => {
    let out = docs;
    for (const m of sql.matchAll(/d\.(cause_num|justice_kind|judgment_code) = \$(\d+)/g)) {
      const col = m[1] as keyof Doc;
      const val = params[Number(m[2]) - 1];
      out = out.filter((d) => String(d[col]) === String(val));
    }
    return out;
  };

  return {
    calls,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('edrsr_case_index') && sql.includes('LIKE')) {
        const [lo, hi, like] = params as string[];
        const prefix = like.replace(/%$/, '');
        return { rows: Object.keys(stored).filter((cn) => cn >= lo && cn < hi && cn.startsWith(prefix)).map(() => ({ '?column?': 1 })) };
      }
      if (sql.includes('edrsr_case_index')) {
        const wanted: string[] = params[0];
        return {
          rows: Object.entries(stored)
            .filter(([cn]) => wanted.includes(cn))
            .map(([cause_num, member_count]) => ({ cause_num, member_count })),
        };
      }
      if (sql.includes('COUNT(')) return { rows: [{ total: applyFilters(sql, params).length }] };
      if (sql.includes('edrsr_documents')) {
        return {
          rows: applyFilters(sql, params).slice(0, 1).map((d) => ({
            ...d, judge: 'Луспеник Д. Д.', court_code: 9911, category_code: null,
            adjudication_date: '2018-02-07', full_text: DECISION_TEXT,
          })),
        };
      }
      return { rows: [] };
    }),
  };
}

describe('causeNumRangeEnd', () => {
  it('bumps the last digit, carrying past 9s and slashes', () => {
    expect(causeNumRangeEnd('352/923/16')).toBe('352/923/17');
    expect(causeNumRangeEnd('352/923/19')).toBe('352/923/2');
    expect(causeNumRangeEnd('352/923/99')).toBe('352/924');
    expect(causeNumRangeEnd('99/999/99')).toBeNull();
  });
});

describe('resolveCauseNumber — reverse direction (typed suffix, stored bare)', () => {
  it('drops a measured procedural suffix when the case is stored without one', async () => {
    const res = await resolveCauseNumber('120/15617/23-а', makeCorpusDb({ '120/15617/23': 2 }));
    expect(res.resolved).toBe('120/15617/23');
  });

  it('does not drop an unmeasured tail — it still names a specific case', async () => {
    const res = await resolveCauseNumber('120/15617/23-XYZ', makeCorpusDb({ '120/15617/23': 2 }));
    expect(res.resolved).toBeNull();
  });

  it('does not drop the suffix when the base also carries a measured differently-suffixed case', async () => {
    const res = await resolveCauseNumber('120/15617/23-а', makeCorpusDb({ '120/15617/23': 2, '120/15617/23-ц': 4 }));
    expect(res.resolved).toBeNull();
  });

  it('does not drop the suffix when the sibling carries a suffix outside the measured list (-кр)', async () => {
    // -кр is not in CAUSE_NUM_SUFFIXES, so the candidate probe never sees it; only the
    // index-wide sibling check does. Without it the bare case would be picked over -кр.
    const db = makeCorpusDb({ '120/15617/23': 2, '120/15617/23-кр': 5 });
    const res = await resolveCauseNumber('120/15617/23-а', db);

    expect(res.resolved).toBeNull();
    const sibling = db.calls.find((c) => c.sql.includes('LIKE'));
    expect(sibling?.params).toEqual(['120/15617/23', '120/15617/24', '120/15617/23-%']);
  });

  it('checks siblings under the other year spelling too', async () => {
    const res = await resolveCauseNumber('120/15617/23-а', makeCorpusDb({ '120/15617/23': 2, '120/15617/2023-кр': 1 }));
    expect(res.resolved).toBeNull();
  });

  it('fails closed when the sibling check errors', async () => {
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('LIKE')) throw new Error('timeout');
        return { rows: [{ cause_num: '120/15617/23', member_count: 2 }] };
      }),
    };
    expect((await resolveCauseNumber('120/15617/23-а', db)).resolved).toBeNull();
  });
});

describe('lookupWithCauseNumberFallback', () => {
  it('returns the exact hit without consulting the resolver', async () => {
    const pool = { query: jest.fn() };
    const run = jest.fn(async (cn: string) => (cn === BARE ? ['exact'] : []));
    const out = await lookupWithCauseNumberFallback(BARE, pool, run, (r) => r.length === 0);

    expect(out.result).toEqual(['exact']);
    expect(out.fallback).toBeUndefined();
    expect(pool.query).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('falls back to the resolved variant on a miss and names it', async () => {
    const db = makeCorpusDb();
    const run = async (cn: string) => (cn === STORED ? ['doc'] : []);
    const out = await lookupWithCauseNumberFallback(BARE, db, run, (r) => r.length === 0);

    expect(out.result).toEqual(['doc']);
    expect(out.causeNumber).toBe(STORED);
    expect(out.fallback).toMatchObject({ requested_case_number: BARE, resolved_case_number: STORED });
    expect(out.fallback?.case_number_note).toContain(STORED);
  });

  it('reports candidates instead of merging when the base is ambiguous', async () => {
    const db = makeCorpusDb({ '123/456/20-ц': 3, '123/456/20-а': 2 });
    const run = jest.fn(async () => [] as string[]);
    const out = await lookupWithCauseNumberFallback('123/456/20', db, run, (r) => r.length === 0);

    expect(out.result).toEqual([]);
    expect(out.fallback?.resolved_case_number).toBeUndefined();
    expect(out.fallback?.ambiguous_case_number?.candidates.sort()).toEqual(['123/456/20-а', '123/456/20-ц']);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stays silent when nothing exists under any spelling', async () => {
    const out = await lookupWithCauseNumberFallback('999/999/99', makeCorpusDb({}), async () => [], (r) => r.length === 0);
    expect(out.fallback).toBeUndefined();
  });
});

describe('search_court_decisions structured — LEXAI-2176', () => {
  it('finds 352/923/16 via its stored spelling 352/923/16-ц and says so', async () => {
    const db = makeCorpusDb();
    const tool = new EdsrUnifiedSearchTool(db as any);
    const result = await tool.executeTool('search_court_decisions', { mode: 'structured', cause_num: BARE });

    expect(result?.isError).toBeFalsy();
    const parsed = JSON.parse(result?.content[0].text || '{}');
    expect(parsed.total).toBe(9);
    expect(parsed.results[0].cause_num).toBe(STORED);
    expect(parsed.requested_case_number).toBe(BARE);
    expect(parsed.resolved_case_number).toBe(STORED);
    expect(parsed.case_number_note).toContain(STORED);
  });

  it('keeps an exact hit as-is, with no fallback note', async () => {
    const db = makeCorpusDb({ [BARE]: 2, [STORED]: 9 });
    const tool = new EdsrUnifiedSearchTool(db as any);
    const result = await tool.executeTool('search_court_decisions', { mode: 'structured', cause_num: BARE });

    const parsed = JSON.parse(result?.content[0].text || '{}');
    expect(parsed.total).toBe(2);
    expect(parsed.resolved_case_number).toBeUndefined();
    expect(db.calls.some((c) => c.sql.includes('edrsr_case_index'))).toBe(false);
  });

  it('keeps the other filters when retrying with the variant', async () => {
    const db = makeCorpusDb();
    const tool = new EdsrUnifiedSearchTool(db as any);
    const run = async (extra: Record<string, any>) => JSON.parse(
      (await tool.executeTool('search_court_decisions', { mode: 'structured', cause_num: BARE, ...extra }))
        ?.content[0].text || '{}',
    );

    // Matching filters: the variant's 9 docs come back.
    expect((await run({ justice_kind: 1, judgment_code: 2 })).total).toBe(9);
    const retry = db.calls.filter((c) => c.sql.includes('COUNT(')).pop();
    expect(retry?.params).toEqual([STORED, 1, 2]);

    // A filter the variant does not satisfy must still exclude it on the retry.
    const excluded = await run({ justice_kind: 2 });
    expect(excluded.total).toBe(0);
    expect(excluded.resolved_case_number).toBeUndefined();
  });
});

describe('get_court_decision — LEXAI-2176', () => {
  const build = (db: any) => new CourtDecisionTools(
    {} as any, {} as any, { extractSections: async () => [] } as any, {} as any, {} as any, db, undefined, undefined,
  );

  it('opens 352/923/16 via 352/923/16-ц and reports the variant', async () => {
    const db = makeCorpusDb();
    const result = await build(db).executeTool('get_court_decision', { case_number: BARE, include_citations: false });

    expect(result?.isError).toBeFalsy();
    const parsed = JSON.parse(result?.content[0].text || '{}');
    expect(parsed.doc_id).toBe(72073973);
    expect(parsed.case_number).toBe(STORED);
    expect(parsed.requested_case_number).toBe(BARE);
    expect(parsed.resolved_case_number).toBe(STORED);
  });

  it('returns the candidates as structured fields when the bare number is ambiguous', async () => {
    const db = makeCorpusDb({ '123/456/20-ц': 3, '123/456/20-а': 2 });
    const result = await build(db).executeTool('get_court_decision', { case_number: '123/456/20' });

    expect(result?.isError).toBe(true);
    const parsed = JSON.parse(result?.content[0].text || '{}');
    expect(parsed.error).toContain('не знайдено');
    expect(parsed.requested_case_number).toBe('123/456/20');
    expect(parsed.ambiguous_case_number.candidates.sort()).toEqual(['123/456/20-а', '123/456/20-ц']);
  });

  it('still says «не знайдено» when no spelling exists', async () => {
    const result = await build(makeCorpusDb({})).executeTool('get_court_decision', { case_number: '999/999/99' });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain('не знайдено');
  });
});
