import { buildAdvocateListQuery, escapeLike } from '../advocates/query';
import { NAAU_PRACTICES, JUSTICE_KINDS } from '../practices';

test('escapes LIKE wildcards in the surname prefix', () => {
  expect(escapeLike('А%_\\')).toBe('А\\%\\_\\\\');
  const q = buildAdvocateListQuery({ surnamePrefix: 'А%_\\' });
  expect(q.params).toContain('А\\%\\_\\\\%');
  expect(q.sql).toMatch(/a\.family_name ILIKE \$\d+/);
});

test('justice kind filter requires cases in that kind and sorts by it', () => {
  const q = buildAdvocateListQuery({ justiceKind: 2, sort: 'cases' });
  expect(q.sql).toContain('ps.cases > 0');
  expect(q.sql).toContain('ORDER BY ps.cases DESC');
  expect(q.params).toContain(2);
});

test('page 3 offsets by 100 and only active advocates are selected', () => {
  const q = buildAdvocateListQuery({ page: 3 });
  expect(q.sql).toContain('OFFSET 100');
  expect(q.sql).toContain('LIMIT 50');
  expect(q.sql).toContain("a.status <> 'TRUE'");
  expect(q.countSql).toContain("a.status <> 'TRUE'");
  expect(q.countSql).not.toContain('OFFSET');
});

test('manual practice, stage and city filters are parameterised', () => {
  const q = buildAdvocateListQuery({ manualPractice: 'ДТП', stage: 'new', city: 'Київ', region: 'Київська' });
  expect(q.sql).toContain('= ANY(l.manual_practices)');
  expect(q.sql).toContain("(l.stage IS NULL OR l.stage = 'new')");
  expect(q.params).toEqual(expect.arrayContaining(['ДТП', 'Київ', 'Київська']));
  expect(q.sql).not.toMatch(/ДТП|Київ/);
});

test('unknown sort falls back to surname; dir is whitelisted', () => {
  const q = buildAdvocateListQuery({ sort: 'drop table' as any, dir: 'bogus' as any });
  expect(q.sql).toContain('ORDER BY a.family_name ASC');
});

test('NAAU_PRACTICES has 59 unique entries and 5 justice kinds are named', () => {
  expect(new Set(NAAU_PRACTICES).size).toBe(59);
  expect(NAAU_PRACTICES).toContain('Кримінальне право та процес');
  expect(JUSTICE_KINDS[2]).toBe('Кримінальне');
  expect(Object.keys(JUSTICE_KINDS)).toHaveLength(5);
});
