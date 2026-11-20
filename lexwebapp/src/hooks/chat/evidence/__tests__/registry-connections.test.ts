import { describe, it, expect } from 'vitest';
import { extractRegistryEvidence } from '../registry';

const graph = {
  root: { id: 'n3', type: 'company', key: '22222220', label: 'ТОВ "БЕТА"' },
  nodes: [
    { id: 'n3', type: 'company', key: '22222220', label: 'ТОВ "БЕТА"', degree: 2, hub: false, depth: 0 },
    { id: 'n2', type: 'person_name', label: 'ТЕСТОВИЧ ТЕСТ', degree: 2, hub: false, depth: 1, match_level: 'name_only' },
    { id: 'n1', type: 'company', key: '11111110', label: 'ТОВ "АЛЬФА"', degree: 1, hub: false, depth: 2, attrs: { status: 'зареєстровано' } },
  ],
  edges: [
    { id: 'e11', from: 'n2', to: 'n3', type: 'head', valid_from: '2021-10-18', valid_to: '2021-11-01', source: 'edr_hist', snapshots: {} },
    { id: 'e10', from: 'n2', to: 'n1', type: 'founder', valid_from: null, valid_to: null, source: 'edr_hist', snapshots: { first_seen: '2018-09-22', current_dump: '2026-11-18' } },
  ],
  truncated: false,
};

describe('extractRegistryEvidence: «Пошук зв\'язків»', () => {
  it('maps each path to a panel card with edge dates and the person caveat', () => {
    const r = extractRegistryEvidence('openreyestr_find_connections', {
      found: true, graph,
      paths: [{ to: 'n1', length: 2, nodes: ['n3', 'n2', 'n1'], edges: ['e11', 'e10'], edge_types: ['head', 'founder'],
        text: 'ТОВ "БЕТА" (22222220) ←керівник— ТЕСТОВИЧ ТЕСТ [ПІБ] —засновник→ ТОВ "АЛЬФА" (11111110)', has_person: true }],
      legend: { edge_types: { founder: 'засновник', head: 'керівник' } },
      warnings: ['Особи в графі згруповані за ПІБ'],
      data_limits: 'Джерело — відкриті дані ЄДР',
      sources: { snapshots: ['2016-07-25', '2021-11-01'], current_dump: '2026-11-18' },
    } as any);
    expect(r.documents).toHaveLength(1);
    expect(r.documents[0].title).toBe('ТОВ "АЛЬФА"');
    const snippet = r.documents[0].metadata!.snippet as string;
    expect(snippet).toContain('←керівник—');
    expect(snippet).toContain('керівник: 2021-10-18 – 2021-11-01');
    expect(snippet).toContain('засновник: 2018-09-22 – чинний на 2026-11-18');
    expect(snippet).toContain('лише кандидат');
    expect(r.documents[0].metadata!.edrpou).toBe('11111110');
    expect(r.citations[0].text).toContain('згруповані за ПІБ');
    expect(r.citations[0].source).toBe('Граф зв\'язків ЄДР, знімки 2016-07-25 – 2021-11-01, поточний дамп 2026-11-18');
  });

  it('falls back to companies without paths and keeps the "not found" message', () => {
    const r = extractRegistryEvidence('openreyestr_find_connections', { found: true, graph, paths: [] } as any);
    expect(r.documents.map((d) => d.title)).toEqual(['ТОВ "АЛЬФА"']);
    const none = extractRegistryEvidence('openreyestr_connection_path', { found: false, message: 'Зв\'язку довжиною до 3 кроків не знайдено.' } as any);
    expect(none.documents).toHaveLength(0);
    expect(none.citations[0].text).toContain('не знайдено');
  });
});
