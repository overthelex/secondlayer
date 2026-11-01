import {
  compareCourtCounts,
  evaluateSnapshotGuards,
  snapshotDateFromName,
  MIN_ROWS_VANISHED,
  MIN_ROWS_DROP,
} from '../court-case-status-guards';

const counts = (o: Record<string, number>) => new Map(Object.entries(o));

describe('compareCourtCounts (LEXAI-2182)', () => {
  it('flags the 31.10.2026 partial ZIP: a court vanished and another nearly did', () => {
    const problems = compareCourtCounts(
      counts({ 'Касаційний цивільний суд': 500000, 'Касаційний господарський суд': 328, 'Касаційний адміністративний суд': 1147 }),
      counts({ 'Касаційний цивільний суд': 520000, 'Касаційний адміністративний суд': 1 }),
    );
    expect(problems).toEqual([
      { court: 'Касаційний адміністративний суд', current: 1147, next: 1, kind: 'dropped' },
      { court: 'Касаційний господарський суд', current: 328, next: 0, kind: 'vanished' },
    ]);
  });

  it('accepts growth and small drops', () => {
    expect(compareCourtCounts(counts({ A: 1000, B: 100 }), counts({ A: 1200, B: 51 }))).toEqual([]);
  });

  it('flags a drop just past the threshold, not at it', () => {
    expect(compareCourtCounts(counts({ A: 100 }), counts({ A: 50 }))).toEqual([]);
    expect(compareCourtCounts(counts({ A: 100 }), counts({ A: 49 }))).toHaveLength(1);
  });

  it('skips the percentage check below MIN_ROWS_DROP but still catches vanishing', () => {
    const small = MIN_ROWS_DROP - 1;
    expect(compareCourtCounts(counts({ A: small }), counts({ A: 1 }))).toEqual([]);
    expect(compareCourtCounts(counts({ A: small }), counts({}))).toEqual([
      { court: 'A', current: small, next: 0, kind: 'vanished' },
    ]);
  });

  it('lets a court with fewer than MIN_ROWS_VANISHED rows disappear', () => {
    expect(compareCourtCounts(counts({ A: MIN_ROWS_VANISHED - 1 }), counts({}))).toEqual([]);
    expect(compareCourtCounts(counts({ A: MIN_ROWS_VANISHED }), counts({}))).toHaveLength(1);
  });

  it('ignores courts that are new in the snapshot', () => {
    expect(compareCourtCounts(counts({}), counts({ A: 10 }))).toEqual([]);
  });

  it('honours custom thresholds', () => {
    expect(compareCourtCounts(counts({ A: 100 }), counts({ A: 80 }), { maxDrop: 0.1 })).toHaveLength(1);
  });
});

describe('evaluateSnapshotGuards (LEXAI-2182)', () => {
  const current = counts({ A: 1000, B: 1000 });

  it('passes a healthy snapshot with no previous load recorded', () => {
    expect(evaluateSnapshotGuards({ current, next: counts({ A: 1010, B: 990 }), fileCount: 26, lastLoad: null }))
      .toEqual({ ok: true, problems: [] });
  });

  it('refuses fewer files than the last successful load', () => {
    const r = evaluateSnapshotGuards({
      current, next: counts({ A: 1010, B: 990 }), fileCount: 26,
      lastLoad: { fileCount: 30, totalRows: 2000, sourceName: 'stan-rozglyadu-sprav-vid-30-10-2026.zip' },
    });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(['snapshot has 26 files, last successful load (stan-rozglyadu-sprav-vid-30-10-2026.zip) had 30']);
  });

  it('accepts the same or more files than the last load', () => {
    const lastLoad = { fileCount: 30, totalRows: 2000, sourceName: null };
    expect(evaluateSnapshotGuards({ current, next: current, fileCount: 30, lastLoad }).ok).toBe(true);
    expect(evaluateSnapshotGuards({ current, next: current, fileCount: 31, lastLoad }).ok).toBe(true);
  });

  it('refuses a snapshot below the total-row ratio and lists per-court problems', () => {
    const r = evaluateSnapshotGuards({ current, next: counts({ A: 1000 }), fileCount: 30, lastLoad: null });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      'snapshot has 1000 rows, table has 2000 (< 80%)',
      'B: 1000 → 0 rows (vanished)',
    ]);
  });

  it('names a court without a name and shows the drop', () => {
    const r = evaluateSnapshotGuards({ current: counts({ '': 200, A: 10000 }), next: counts({ '': 20, A: 10000 }), fileCount: 1, lastLoad: null });
    expect(r.problems).toEqual(['(без назви суду): 200 → 20 rows (−90%)']);
  });
});

describe('snapshotDateFromName', () => {
  it('reads DD-MM-YYYY from the ДСА file name', () => {
    expect(snapshotDateFromName('stan-rozglyadu-sprav-vid-31-10-2026.zip')).toBe('2026-10-31');
    expect(snapshotDateFromName('/tmp/court_case_status/stan-rozglyadu-sprav-vid-01.11.2026.zip')).toBe('2026-11-01');
  });

  it('returns null without a valid date', () => {
    expect(snapshotDateFromName('export.zip')).toBeNull();
    expect(snapshotDateFromName('stan-rozglyadu-sprav-vid-31-02-2026.zip')).toBeNull();
  });
});
