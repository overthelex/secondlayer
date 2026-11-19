import { describe, it, expect } from 'vitest';
import { extractRegistryEvidence } from '../registry';

describe('extractRegistryEvidence: ЄДР history', () => {
  it('keeps snapshot, source, status and the match caveat for history searches', () => {
    const r = extractRegistryEvidence('openreyestr_search_founders_history', {
      found: true,
      results: [{ edrpou: '11111111', company_name: 'ТОВ "АЛЬФА"', company_status: 'зареєстровано', name: 'ТЕСТОВИЧ ТЕСТ',
        country: 'Кіпр', first_seen: '2016-05-01', last_seen: '2021-10-25', current: false, match: 'точний збіг імені (наводка)' }],
      snapshots: [{ date: '2016-05-01', source: 'data.gov.ua' }, { date: '2021-10-25', source: 'data.gov.ua' }],
      warning: 'Збіг за назвою чи ПІБ — лише наводка',
    } as any);
    expect(r.documents).toHaveLength(1);
    const snippet = r.documents[0].metadata!.snippet as string;
    expect(snippet).toContain('Стан: зареєстровано');
    expect(snippet).toContain('2016-05-01 – 2021-10-25');
    expect(snippet).toContain('наводка');
    expect(r.citations[0].text).toContain('лише наводка');
    expect(r.citations[0].source).toContain('Знімки ЄДР: 2016-05-01, 2021-10-25');
  });

  it('maps company_as_of with the snapshot date and source', () => {
    const r = extractRegistryEvidence('openreyestr_company_as_of', {
      found: true, edrpou: '11111111', as_of: '2022-01-01',
      snapshot: { date: '2021-10-25', source: 'data.gov.ua' },
      fields: { name: { values: ['ТОВ "АЛЬФА-ПЛЮС"'] }, status: { values: ['зареєстровано'] } },
      note: 'Стан за відкритими даними ЄДР на знімок 2021-10-25',
    } as any);
    expect(r.documents[0].title).toBe('ТОВ "АЛЬФА-ПЛЮС"');
    expect(r.documents[0].metadata!.snippet).toContain('Знімок ЄДР: 2021-10-25 (на 2022-01-01)');
    expect(r.citations[0].source).toBe('Знімок ЄДР 2021-10-25. Джерело: data.gov.ua');
  });
});
