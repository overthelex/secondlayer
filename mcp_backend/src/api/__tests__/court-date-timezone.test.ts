import { formatCourtDate } from '../tool-utils';

/**
 * Regression for the 907/665/18 report (2026-08-13): every date in the answer was
 * one day early. `adjudication_date` is a timestamptz at Kyiv midnight, so the
 * постанова of 23.04.2026 is the instant 2026-04-22T21:00:00Z; serialised as an
 * ISO string it reached the model as "2026-04-22…" and got reported as 22.04.2026.
 *
 * The dates below are the instants stored in edrsr_documents for real documents
 * of that case, paired with the date printed on the document itself.
 */
describe('formatCourtDate', () => {
  it.each([
    ['2026-04-22T21:00:00.000Z', '2026-04-23', 'постанова про визнання банкрутом (summer, +03)'],
    ['2018-11-19T22:00:00.000Z', '2018-11-20', 'ухвала про прийняття заяви (winter, +02)'],
    ['2021-12-21T22:00:00.000Z', '2021-12-22', 'постанова ЗАГС у справі ФК «Монтале»'],
    ['2023-06-21T21:00:00.000Z', '2023-06-22', 'постанова ЗАГС (Тищенко/ТКСЗ)'],
    ['2024-08-21T21:00:00.000Z', '2024-08-22', 'постанова ЗАГС (ГУ ДПС)'],
    ['2025-04-28T21:00:00.000Z', '2025-04-29', 'постанова ЗАГС (Фінактив)'],
  ])('%s → %s (%s)', (stored, expected) => {
    expect(formatCourtDate(stored)).toBe(expected);
    expect(formatCourtDate(new Date(stored))).toBe(expected);
  });

  it('keeps date-only values exactly as they are', () => {
    expect(formatCourtDate('2026-04-23')).toBe('2026-04-23');
  });

  it('holds across the DST switch in both directions', () => {
    // Kyiv moves to +03 on the last Sunday of March, back to +02 in late October.
    expect(formatCourtDate('2025-03-29T22:00:00.000Z')).toBe('2025-03-30'); // +02 → local midnight
    expect(formatCourtDate('2025-03-30T21:00:00.000Z')).toBe('2025-03-31'); // +03 → local midnight
    expect(formatCourtDate('2025-10-25T21:00:00.000Z')).toBe('2025-10-26');
    expect(formatCourtDate('2025-10-26T22:00:00.000Z')).toBe('2025-10-27');
  });

  it('returns undefined for empty values rather than an epoch date', () => {
    expect(formatCourtDate(null)).toBeUndefined();
    expect(formatCourtDate(undefined)).toBeUndefined();
    expect(formatCourtDate('')).toBeUndefined();
    expect(formatCourtDate(new Date('nonsense'))).toBeUndefined();
  });

  it('passes unparseable input through untouched instead of inventing a date', () => {
    expect(formatCourtDate('не встановлено')).toBe('не встановлено');
  });
});
