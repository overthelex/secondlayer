/**
 * Case-number suffix resolution.
 *
 * The chat model strips the procedural suffix on its way to a tool — it was asked about
 * 369/6892/15-ц and called check_precedent_status with 369/6892/15. The bare number matches
 * no cause_num, so shepardization returned `unknown` (0.5) rather than explicitly_overruled
 * (0.95) and the answer read "справу не знайдено в ЄДРСР": a confident false negative on
 * the question the tool exists to answer. External MCP v2 clients hit the same path.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { generateCaseNumberCandidates, resolveCauseNumber } from '../tool-utils';

const makeDb = (rows: Array<{ cause_num: string; member_count: number }>) => {
  const calls: { sql: string; params: any[] }[] = [];
  return {
    calls,
    query: jest.fn((sql: string, params: any[]) => {
      calls.push({ sql, params });
      return Promise.resolve({ rows });
    }),
  };
};

describe('generateCaseNumberCandidates', () => {
  it('adds suffixed spellings that generateCaseNumberVariations never produces', () => {
    const candidates = generateCaseNumberCandidates('369/6892/15');

    expect(candidates).toContain('369/6892/15');      // the input itself
    expect(candidates).toContain('369/6892/15-ц');    // the spelling EDRSR actually stores
    expect(candidates).toContain('369/6892/15-а');
    expect(candidates).toContain('369/6892/2015-ц');  // combined with year expansion
  });

  it('expands the year for multi-letter suffixes too', () => {
    // The variations regex used to match a single suffix character, so ад/НМ/НА/НР/АП
    // failed the pattern outright and got no year expansion at all.
    const candidates = generateCaseNumberCandidates('905/1234/20-ад');

    expect(candidates).toContain('905/1234/20-ад');
    expect(candidates).toContain('905/1234/2020-ад');
  });

  it('does not pile suffixes onto a number that already has one', () => {
    const candidates = generateCaseNumberCandidates('369/6892/15-ц');

    expect(candidates).toContain('369/6892/15-ц');
    expect(candidates.some((c) => /-ц-/.test(c))).toBe(false);
    // Stripping stays available — that direction already worked.
    expect(candidates).toContain('369/6892/15');
  });
});

describe('resolveCauseNumber', () => {
  it('rewrites a suffix-stripped number to the one case that exists', async () => {
    const db = makeDb([{ cause_num: '369/6892/15-ц', member_count: 40 }]);
    const res = await resolveCauseNumber('369/6892/15', db);

    expect(res.resolved).toBe('369/6892/15-ц');
    expect(res.ambiguous).toBe(false);
    // Equality against the cause_num primary key, not a prefix LIKE: the database
    // collation is en_US.utf8, where LIKE 'base%' cannot use that index and seq-scans
    // (5.2s measured on prod, against 1.7ms for this form).
    expect(db.calls[0].sql).toContain('cause_num = ANY($1::text[])');
    expect(db.calls[0].sql).not.toContain('LIKE');
  });

  it('keeps the caller spelling when it exists, even alongside other suffixes', async () => {
    const db = makeDb([
      { cause_num: '910/3134/22-ц', member_count: 90 },
      { cause_num: '910/3134/22', member_count: 63 },
    ]);
    const res = await resolveCauseNumber('910/3134/22', db);

    // Do not "upgrade" someone who was already specific, even to a bigger case.
    expect(res.resolved).toBe('910/3134/22');
    expect(res.ambiguous).toBe(false);
  });

  it('refuses to choose when one base number covers several real cases', async () => {
    const db = makeDb([
      { cause_num: '123/456/20-ц', member_count: 12 },
      { cause_num: '123/456/20-а', member_count: 9 },
    ]);
    const res = await resolveCauseNumber('123/456/20', db);

    // ~1 base in 700 carries two suffixes and those are different cases. Merging them
    // would fabricate a single instance chain out of two, so the caller is told instead.
    expect(res.resolved).toBeNull();
    expect(res.ambiguous).toBe(true);
    expect(res.matches.map((m) => m.cause_num)).toEqual(['123/456/20-ц', '123/456/20-а']);
  });

  it('never swaps a suffix the caller actually typed for a different one', async () => {
    // Regression guard. Widening the variations regex to accept multi-letter suffixes made
    // it strip unmeasured ones too, so 905/1234/20-XYZ decayed to 905/1234/20, picked the
    // measured suffixes up as candidates, and would have resolved to 905/1234/20-ц — a
    // different real case answered as though it were the one asked about.
    const db = makeDb([{ cause_num: '905/1234/20-ц', member_count: 30 }]);
    const res = await resolveCauseNumber('905/1234/20-XYZ', db);

    expect(res.resolved).toBeNull();
    expect(res.ambiguous).toBe(false);

    // Same rule for a measured suffix that simply does not exist: -а must not become -ц.
    const db2 = makeDb([{ cause_num: '905/1234/20-ц', member_count: 30 }]);
    expect((await resolveCauseNumber('905/1234/20-а', db2)).resolved).toBeNull();
  });

  it('still completes a missing suffix and honours year expansion within one suffix', async () => {
    const db = makeDb([{ cause_num: '905/1234/2020-ад', member_count: 5 }]);
    const res = await resolveCauseNumber('905/1234/20-ад', db);

    // Same suffix, different year spelling — allowed, because the suffix is not being swapped.
    expect(res.resolved).toBe('905/1234/2020-ад');
  });

  it('still rewrites a legacy VSU number to its canonical slash spelling', async () => {
    // The suffix guard must not read the hyphen inside a pre-2017 Supreme Court identifier
    // as a caller-chosen suffix: "5-15кс12" would then never match "5-15/12", which has no
    // suffix at all, and the guard would block the very rewrite the VSU branch exists for.
    const db = makeDb([{ cause_num: '5-15/12', member_count: 6 }]);
    const res = await resolveCauseNumber('5-15кс12', db);

    expect(res.resolved).toBe('5-15/12');
  });

  it('resolves to nothing when the number matches no case at all', async () => {
    const res = await resolveCauseNumber('999/999/99', makeDb([]));

    expect(res.resolved).toBeNull();
    expect(res.ambiguous).toBe(false);
    expect(res.matches).toEqual([]);
  });

  it('falls back silently when the lookup fails or no pool is available', async () => {
    const broken = { query: jest.fn(() => Promise.reject(new Error('boom'))) };
    await expect(resolveCauseNumber('369/6892/15', broken)).resolves.toEqual({
      resolved: null, matches: [], ambiguous: false,
    });
    // No pool at all (optional constructor arg not wired) must not throw either.
    await expect(resolveCauseNumber('369/6892/15', undefined)).resolves.toEqual({
      resolved: null, matches: [], ambiguous: false,
    });
  });

  it('does not query for an empty case number', async () => {
    const db = makeDb([{ cause_num: 'x', member_count: 1 }]);
    const res = await resolveCauseNumber('   ', db);

    expect(db.query).not.toHaveBeenCalled();
    expect(res.resolved).toBeNull();
  });
});
