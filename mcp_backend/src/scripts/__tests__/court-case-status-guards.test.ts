import {
  compareCourtCounts,
  courtBaseline,
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
      lastLoad: { fileCount: 30, totalRows: 2000, sourceName: 'stan-rozglyadu-sprav-vid-30-10-2026.zip', courtCounts: counts({}) },
    });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(['snapshot has 26 files, last unforced load (stan-rozglyadu-sprav-vid-30-10-2026.zip) had 30']);
  });

  it('accepts the same or more files than the last load', () => {
    const lastLoad = { fileCount: 30, totalRows: 2000, sourceName: null, courtCounts: counts({}) };
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

  it('requires a court the table already lost but the last load had (repeat of 31.10.2026)', () => {
    // The table holds the partial 31.10 load (no КГС); the seeded 30.10 baseline still has it.
    const lastLoad = {
      fileCount: 26, totalRows: 2000, sourceName: 'stan-rozglyadu-sprav-vid-30-10-2026.zip',
      courtCounts: counts({ A: 1000, 'Касаційний господарський суд': 328, 'Касаційний адміністративний суд': 1147 }),
    };
    const r = evaluateSnapshotGuards({
      current: counts({ A: 1000, 'Касаційний адміністративний суд': 1 }),
      next: counts({ A: 1000, 'Касаційний адміністративний суд': 1 }),
      fileCount: 26,
      lastLoad,
    });
    expect(r.problems).toEqual([
      'Касаційний адміністративний суд: 1147 → 1 rows (−99%)',
      'Касаційний господарський суд: 328 → 0 rows (vanished)',
    ]);
  });

  it('keeps refusing a court at 0 after a forced load dropped it (baseline = last unforced load)', () => {
    // A --force run swapped in a snapshot without B: the table has no B rows now, and
    // readLastLoad skips that forced row, so the baseline is still the 30.10 load with B.
    const unforced = { fileCount: 30, totalRows: 1328, sourceName: 'stan-rozglyadu-sprav-vid-30-10-2026.zip',
      courtCounts: counts({ A: 1000, B: 328 }) };
    const afterForced = { current: counts({ A: 1000 }), next: counts({ A: 1003 }), fileCount: 26 };
    const r = evaluateSnapshotGuards({ ...afterForced, lastLoad: unforced });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      'snapshot has 26 files, last unforced load (stan-rozglyadu-sprav-vid-30-10-2026.zip) had 30',
      'B: 328 → 0 rows (vanished)',
    ]);
    // Had the forced load (26 files, no B) been the baseline, the same snapshot would pass.
    const forced = { fileCount: 26, totalRows: 1000, sourceName: 'forced.zip', courtCounts: counts({ A: 1000 }) };
    expect(evaluateSnapshotGuards({ ...afterForced, lastLoad: forced }).ok).toBe(true);
  });

  it('passes once the snapshot restores the courts of the last load', () => {
    const lastLoad = { fileCount: 30, totalRows: 1328, sourceName: null, courtCounts: counts({ A: 1000, B: 328 }) };
    expect(evaluateSnapshotGuards({
      current: counts({ A: 1000 }), next: counts({ A: 1005, B: 330 }), fileCount: 30, lastLoad,
    })).toEqual({ ok: true, problems: [] });
  });
});

describe('courtBaseline', () => {
  it('takes the larger count per court from the table and the last load', () => {
    expect(courtBaseline(counts({ A: 10, B: 5 }), counts({ A: 7, B: 9, C: 3 })))
      .toEqual(counts({ A: 10, B: 9, C: 3 }));
  });

  it('is the table counts when no load is recorded', () => {
    expect(courtBaseline(counts({ A: 10 }), null)).toEqual(counts({ A: 10 }));
  });
});

describe('snapshotDateFromName', () => {
  it('reads DD-MM-YYYY from the ДСА file name', () => {
    expect(snapshotDateFromName('stan-rozglyadu-sprav-vid-31-10-2026.zip')).toBe('2026-10-31');
    expect(snapshotDateFromName('/tmp/court_case_status/stan-rozglyadu-sprav-vid-01-11-2026.zip')).toBe('2026-11-01');
  });

  it('returns null without a valid date', () => {
    expect(snapshotDateFromName('export.zip')).toBeNull();
    expect(snapshotDateFromName('stan-rozglyadu-sprav-vid-31-02-2026.zip')).toBeNull();
  });

  it('matches only the anchored ДСА basename with the year right before .zip', () => {
    expect(snapshotDateFromName('/tmp/30-10-2026/export.zip')).toBeNull();
    expect(snapshotDateFromName('copy-stan-rozglyadu-sprav-vid-31-10-2026.zip')).toBeNull();
    expect(snapshotDateFromName('stan-rozglyadu-sprav-vid-31-10-2026-v2.zip')).toBeNull();
    expect(snapshotDateFromName('stan-rozglyadu-sprav-vid-31-10-2026.zip.part')).toBeNull();
    expect(snapshotDateFromName('stan-rozglyadu-sprav-vid-31.10.2026.zip')).toBeNull();
    expect(snapshotDateFromName('/data/stan-rozglyadu-sprav-vid-31-10-2026')).toBeNull();
  });
});
