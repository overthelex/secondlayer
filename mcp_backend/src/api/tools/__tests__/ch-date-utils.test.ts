import { isValidIsoDate } from '../ch-date-utils';

describe('isValidIsoDate', () => {
  it('accepts well-formed calendar-valid dates', () => {
    expect(isValidIsoDate('2024-02-29')).toBe(true); // leap year
    expect(isValidIsoDate('2020-01-01')).toBe(true);
    expect(isValidIsoDate('2020-12-31')).toBe(true);
  });

  it('rejects a day that overflows its month, even though the shape looks right', () => {
    expect(isValidIsoDate('2024-02-31')).toBe(false);
    expect(isValidIsoDate('2023-02-29')).toBe(false); // not a leap year
    expect(isValidIsoDate('2020-04-31')).toBe(false);
  });

  it('rejects a month out of range', () => {
    expect(isValidIsoDate('2025-13-01')).toBe(false);
    expect(isValidIsoDate('2025-00-01')).toBe(false);
  });

  it('rejects malformed shapes', () => {
    expect(isValidIsoDate('01-01-2020')).toBe(false);
    expect(isValidIsoDate('2020/01/01')).toBe(false);
    expect(isValidIsoDate('not-a-date')).toBe(false);
    expect(isValidIsoDate('')).toBe(false);
  });
});
