import { listAdvocates, getAdvocate, getPracticeProfile, listCities, parseKindSummary } from '../advocates/repo';

function fakePool(answers: (text: string) => Record<string, unknown>[]) {
  const calls: { text: string; values?: unknown[] }[] = [];
  return {
    calls,
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      const rows = answers(text);
      return { rows, rowCount: rows.length };
    },
  };
}

const row = {
  source_id: '42', family_name: 'Коваль', first_name: 'Іван', patronymic: 'Петрович', status: 'active',
  status_description: null, email: 'k@x.ua', phone: '+38(044)111-11-11', work_address: 'Київ', city: 'Київ',
  region: 'м. Київ', org_forms: 'АО Коваль', ra_name: 'Рада адвокатів м. Києва', certificate_num: '1/1',
  certificate_date: new Date('2010-01-01'), decision_num: null, decision_date: null, authority_name: null,
  stage: null, next_contact_at: null, manual_practices: null, last_contact: null, kind_cases: 0, kind_summary: '2:120,1:3',
};

test('parseKindSummary turns "2:120,1:3" into named kinds in that order', () => {
  expect(parseKindSummary('2:120,1:3')).toEqual([
    { justiceKind: 2, name: 'Кримінальне', cases: 120 },
    { justiceKind: 1, name: 'Цивільне', cases: 3 },
  ]);
  expect(parseKindSummary(null)).toEqual([]);
});

test('listAdvocates returns mapped rows, total and page', async () => {
  const pool = fakePool((t) => (t.includes('count(*)') ? [{ total: 137 }] : [row]));
  const r = await listAdvocates(pool as any, { page: 2 });
  expect(r.total).toBe(137);
  expect(r.page).toBe(2);
  expect(r.rows[0]).toMatchObject({ sourceId: '42', fullName: 'Коваль Іван Петрович', stage: 'new', manualPractices: [] });
  expect(r.rows[0].kinds[0]).toEqual({ justiceKind: 2, name: 'Кримінальне', cases: 120 });
});

test('getAdvocate does not filter by status and returns null when unknown', async () => {
  const pool = fakePool(() => []);
  expect(await getAdvocate(pool as any, 'nope')).toBeNull();
  expect(pool.calls[0].text).not.toContain("a.status <> 'TRUE'");
  expect(pool.calls[0].values).toEqual(['nope']);
});

test('getPracticeProfile names kinds and lists top categories', async () => {
  const pool = fakePool((t) =>
    t.includes('edrsr_cause_categories')
      ? [{ category_code: 40379, name: 'Спори про право власності', cases: 7 }]
      : [{ justice_kind: 1, cases: 10, first_year: 2024, last_year: 2026 }],
  );
  const p = await getPracticeProfile(pool as any, '42');
  expect(p.kinds).toEqual([{ justiceKind: 1, name: 'Цивільне', cases: 10, firstYear: 2024, lastYear: 2026 }]);
  expect(p.topCategories).toEqual([{ categoryCode: 40379, name: 'Спори про право власності', cases: 7 }]);
  expect(pool.calls[1].text).toContain('LIMIT 3');
});

test('listCities is cached for an hour', async () => {
  const pool = fakePool(() => [{ v: 'Київ' }, { v: 'Львів' }]);
  const a = await listCities(pool as any, 1000);
  const b = await listCities(pool as any, 1000 + 60 * 1000);
  expect(a).toEqual(['Київ', 'Львів']);
  expect(b).toBe(a);
  expect(pool.calls).toHaveLength(1);
  await listCities(pool as any, 1000 + 3600 * 1000 + 1);
  expect(pool.calls).toHaveLength(2);
});
