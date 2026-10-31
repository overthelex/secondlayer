import {
  normalizeCourtDate,
  parseQuotedTsv,
  columnIndex,
  toTargetRow,
  SOURCE_COLUMNS,
  TARGET_COLUMNS,
  pickLatestZip,
} from '../court-case-status-dates';
import { CourtStatusTools, STAGE_DATE_SORT_SQL } from '../../api/tools/court-status-tools';

const MAX = 2027;

describe('normalizeCourtDate (LEXAI-2173)', () => {
  it('keeps plausible dates as they are', () => {
    expect(normalizeCourtDate('18.10.2023', MAX)).toEqual({ value: '18.10.2023', fix: 'ok' });
    expect(normalizeCourtDate(' 29.02.2024 ', MAX)).toEqual({ value: '29.02.2024', fix: 'ok' });
    expect(normalizeCourtDate('10.09.2027', MAX)).toEqual({ value: '10.09.2027', fix: 'ok' });
  });

  it('repairs a doubled two-digit year (the reported rows)', () => {
    expect(normalizeCourtDate('01.12.2323', MAX)).toEqual({ value: '01.12.2023', fix: 'repaired' });
    expect(normalizeCourtDate('29.02.2424', MAX)).toEqual({ value: '29.02.2024', fix: 'repaired' });
    expect(normalizeCourtDate('02.08.2121', MAX)).toEqual({ value: '02.08.2021', fix: 'repaired' });
    expect(normalizeCourtDate('11.06.2626', MAX)).toEqual({ value: '11.06.2026', fix: 'repaired' });
  });

  it('drops years that cannot be recovered', () => {
    for (const s of ['15.02.0180', '25.05.5018', '28.08.9022', '22.02.2122', '07.01.4202', '19.12.2919', '29.10.2029']) {
      expect(normalizeCourtDate(s, MAX)).toEqual({ value: null, fix: 'dropped' });
    }
  });

  it('drops impossible day/month and non-dates, empty stays empty', () => {
    expect(normalizeCourtDate('31.13.2024', MAX).value).toBeNull();
    expect(normalizeCourtDate('00.10.2024', MAX).value).toBeNull();
    expect(normalizeCourtDate('2024-10-01', MAX)).toEqual({ value: null, fix: 'dropped' });
    expect(normalizeCourtDate('', MAX)).toEqual({ value: null, fix: 'empty' });
    expect(normalizeCourtDate(null, MAX)).toEqual({ value: null, fix: 'empty' });
  });
});

describe('ДСА TSV parsing', () => {
  const header = SOURCE_COLUMNS.map((c) => `"${c}"`).join('\t');
  const line = (vals: string[]) => vals.map((v) => `"${v.replace(/"/g, '""')}"`).join('\t');
  const rec = (over: Partial<Record<string, string>>) =>
    SOURCE_COLUMNS.map((c) => over[c] ?? '');

  it('handles quoted tabs, doubled quotes and newlines inside fields', () => {
    const text = '﻿' + header + '\r\n' +
      line(rec({ case_number: '9901/221/21', description: 'про "щось"\nдругий рядок\tз табом' })) + '\n';
    const rows = [...parseQuotedTsv(text)];
    expect(rows).toHaveLength(2);
    expect(rows[0][0]).toBe('court_name');
    expect(rows[1][1]).toBe('9901/221/21');
    expect(rows[1][12]).toBe('про "щось"\nдругий рядок\tз табом');
  });

  it('maps "type" to case_type, normalises dates and counts fixes', () => {
    const rows = [...parseQuotedTsv(header + '\n' + line(rec({
      court_name: 'Велика Палата Верховного Суду', case_number: '990/326/23',
      registration_date: '05.02.2024', stage_date: '29.02.2424', type: 'Апеляційна скарга',
    })) + '\n' + line(rec({ case_number: ' ' })))];
    const idx = columnIndex(rows[0]);
    const stats = { repaired: 0, dropped: 0 };
    const out = toTargetRow(idx, rows[1], MAX, stats)!;
    expect(TARGET_COLUMNS[11]).toBe('case_type');
    expect(out[11]).toBe('Апеляційна скарга');
    expect(out[3]).toBe('05.02.2024');
    expect(out[7]).toBe('29.02.2024');
    expect(stats).toEqual({ repaired: 1, dropped: 0 });
    expect(toTargetRow(idx, rows[2], MAX, stats)).toBeNull();
  });

  it('rejects a header that lacks a column', () => {
    expect(() => columnIndex(['court_name', 'case_number'])).toThrow(/lacks/);
  });
});

describe('pickLatestZip', () => {
  it('picks the newest zip and ignores the 2022 monthly CSV files', () => {
    const r = pickLatestZip([
      { url: 'https://x/stan-z-01-04-2022.csv', last_modified: '2026-12-01T00:00:00' },
      { url: 'https://x/stan-rozglyadu-sprav-vid-29-10-2026.zip', last_modified: '2026-10-30T07:00:00' },
      { url: 'https://x/stan-rozglyadu-sprav-vid-30-10-2026.zip', last_modified: '2026-10-31T07:17:58' },
    ]);
    expect(r?.url).toContain('vid-30-10-2026.zip');
    expect(pickLatestZip([{ url: 'https://x/a.csv' }])).toBeNull();
  });
});

describe('search_court_case_status ordering (LEXAI-2173)', () => {
  it('orders by a sort key that ignores implausible years', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ case_number: '990/326/23' }] }) };
    await new CourtStatusTools(db).executeTool('search_court_case_status', { judge: 'Пільков', limit: 5 });
    const [sql] = db.query.mock.calls[0];
    expect(sql).toContain(`ORDER BY ${STAGE_DATE_SORT_SQL} DESC NULLS LAST`);
    expect(STAGE_DATE_SORT_SQL).toContain('BETWEEN 1991 AND extract(year FROM now())::int + 1');
  });
});
