import {
  buildWhere,
  parseCourtSearchIR,
  parseIntentIR,
  parsePlannerSlots,
  parseEdsrSearchArgs,
  CourtSearchIR,
  PROCEDURE_TO_JUSTICE_KIND,
} from '../src/query-ir';
import type { FieldDef } from '../src/query-ir';

describe('query-ir / parseCourtSearchIR', () => {
  it('accepts a valid IR and returns typed value', () => {
    const r = parseCourtSearchIR({
      query_fts: 'оренда землі',
      procedure_code: 'gpc',
      justice_kind: 3,
      court_level: 'cassation',
      party_role: 'plaintiff',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.procedure_code).toBe('gpc');
      expect(r.value.justice_kind).toBe(3);
    }
  });

  it('DROPS unknown fields (injection guard via z.strictObject)', () => {
    const r = parseCourtSearchIR({
      query_fts: 'тест',
      ['; DROP TABLE decisions;--']: 1,
      arbitrary_filter: 'x',
    });
    // strictObject => unknown keys make it fail, never silently pass through
    expect(r.ok).toBe(false);
  });

  it('rejects enum values outside the whitelist', () => {
    const r = parseCourtSearchIR({ court_level: 'supreme_galactic_court' });
    expect(r.ok).toBe(false);
  });

  it('rejects malformed dates', () => {
    const r = parseCourtSearchIR({ date_from: '06/01/2026' });
    expect(r.ok).toBe(false);
  });

  it('extracts JSON object from a raw LLM string', () => {
    const r = parseCourtSearchIR('here you go:\n{"query_fts":"борг","justice_kind":1}\nhope it helps');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.justice_kind).toBe(1);
  });

  it('degrades (ok:false, no throw) on garbage input', () => {
    expect(parseCourtSearchIR('not json at all').ok).toBe(false);
    expect(parseCourtSearchIR(42).ok).toBe(false);
    expect(parseCourtSearchIR(null).ok).toBe(false);
  });
});

describe('query-ir / parseIntentIR', () => {
  it('validates query_type against the whitelist and keeps stable slot names', () => {
    const r = parseIntentIR({
      query_type: 'registry_lookup',
      slots: { edrpou: '12345678' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.slots?.edrpou).toBe('12345678');
  });

  it('rejects an unknown query_type', () => {
    expect(parseIntentIR({ query_type: 'time_travel' }).ok).toBe(false);
  });
});

describe('query-ir / parsePlannerSlots', () => {
  it('accepts Ukrainian-convention planner slots', () => {
    const r = parsePlannerSlots({
      procedure_code: 'ЦПК',
      court_level: 'cassation',
      case_category: 'споживчий спір',
      section_focus: ['COURT_REASONING', 'DECISION'],
      money_terms: { penalty: true },
      desired_output: 'таблиця',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.procedure_code).toBe('ЦПК');
      expect(r.value.desired_output).toBe('таблиця');
    }
  });

  it('rejects latin procedure_code (planner uses the Ukrainian convention)', () => {
    expect(parsePlannerSlots({ procedure_code: 'cpc' }).ok).toBe(false);
  });

  it('DROPS unknown slot keys (injection guard)', () => {
    expect(parsePlannerSlots({ court_level: 'appeal', registry_tool_hint: 'x' }).ok).toBe(false);
  });

  it('rejects a non-canonical court_level (alias normalization is the planner job)', () => {
    // 'велика палата' must be normalized to 'GrandChamber' BEFORE validation
    expect(parsePlannerSlots({ court_level: 'велика палата' }).ok).toBe(false);
    expect(parsePlannerSlots({ court_level: 'GrandChamber' }).ok).toBe(true);
  });

  it('degrades (ok:false, no throw) on garbage', () => {
    expect(parsePlannerSlots('nope').ok).toBe(false);
    expect(parsePlannerSlots(null).ok).toBe(false);
  });
});

describe('query-ir / PROCEDURE_TO_JUSTICE_KIND', () => {
  it('maps procedure codes to justice kinds', () => {
    expect(PROCEDURE_TO_JUSTICE_KIND.cpc).toBe(1);
    expect(PROCEDURE_TO_JUSTICE_KIND.crpc).toBe(2);
    expect(PROCEDURE_TO_JUSTICE_KIND.gpc).toBe(3);
    expect(PROCEDURE_TO_JUSTICE_KIND.cac).toBe(4);
  });
});

describe('query-ir / buildWhere', () => {
  const FIELDS: FieldDef[] = [
    { name: 'name', match: 'ilike', columns: ['name'] },
    { name: 'edrpou', match: 'exact', columns: ['edrpou'] },
    { name: 'justice_kind', match: 'exact', columns: ['d.justice_kind'], type: 'number' },
    { name: 'code', match: 'exact', columns: ['code'], transform: 'uppercase' },
    { name: 'tags', match: 'array_contains', columns: ['tags'] },
    { name: 'date_from', match: 'gte', columns: ['d.adjudication_date'] },
    { name: 'owner', match: 'ilike_multi', columns: ['owner_a', 'owner_b'] },
    { name: 'status', match: 'exact_ci', columns: ['status'] },
    { name: 'name_prefix', match: 'prefix', columns: ['name'] },
  ];

  it('builds parameterized conditions joined by AND', () => {
    const r = buildWhere(FIELDS, { name: 'Іван', edrpou: '12345678' });
    expect(r.whereClause).toBe('name ILIKE $1 AND edrpou = $2');
    expect(r.values).toEqual(['%Іван%', '12345678']);
    expect(r.nextParamIndex).toBe(3);
  });

  it('ignores fields not present in the whitelist', () => {
    const r = buildWhere(FIELDS, { name: 'x', injected_col: 'DROP', '1=1': true });
    expect(r.whereClause).toBe('name ILIKE $1');
    expect(r.values).toEqual(['%x%']);
  });

  it('coerces numbers and uppercases when declared', () => {
    const r = buildWhere(FIELDS, { justice_kind: '3', code: 'abc' });
    expect(r.whereClause).toBe('d.justice_kind = $1 AND code = $2');
    expect(r.values).toEqual([3, 'ABC']);
  });

  it('skips null / undefined / empty-string values', () => {
    const r = buildWhere(FIELDS, { name: '', edrpou: null, justice_kind: undefined });
    expect(r.whereClause).toBeNull();
    expect(r.values).toEqual([]);
    expect(r.nextParamIndex).toBe(1);
  });

  it('renders array_contains, gte and ilike_multi correctly', () => {
    const r = buildWhere(FIELDS, { tags: 'urgent', date_from: '2026-01-01', owner: 'ТОВ' });
    expect(r.whereClause).toBe(
      '$1 = ANY(tags) AND d.adjudication_date >= $2 AND (owner_a ILIKE $3 OR owner_b ILIKE $3)'
    );
    expect(r.values).toEqual(['urgent', '2026-01-01', '%ТОВ%']);
  });

  it('exact_ci matches case-insensitively WITHOUT substring wildcards (status "active" ≠ "inactive")', () => {
    const r = buildWhere(FIELDS, { status: 'active' });
    // ILIKE with the value verbatim (no %) => case-insensitive equality, so
    // "active" cannot match the stored "inactive".
    expect(r.whereClause).toBe('status ILIKE $1');
    expect(r.values).toEqual(['active']);
  });

  it('prefix anchors at the start and escapes LIKE wildcards in the value', () => {
    const r = buildWhere(FIELDS, { name_prefix: 'А' });
    expect(r.whereClause).toBe('name ILIKE $1');
    expect(r.values).toEqual(['А%']);

    const escaped = buildWhere(FIELDS, { name_prefix: '50%_x' });
    expect(escaped.values).toEqual(['50\\%\\_x%']);
  });

  it('renders eq_any (col = ANY($N)) for array-valued slots', () => {
    const fields: FieldDef[] = [
      { name: 'category_codes', match: 'eq_any', columns: ['d.category_code'] },
    ];
    const r = buildWhere(fields, { category_codes: [40851, 5459] });
    expect(r.whereClause).toBe('d.category_code = ANY($1)');
    expect(r.values).toEqual([[40851, 5459]]);
  });

  it('matches the EDRSR structured WHERE shape and param order', () => {
    // mirrors edrsr-unified-search-tool.searchStructured field order
    const fields: FieldDef[] = [
      { name: 'judge', match: 'ilike', columns: ['d.judge'] },
      { name: 'court_codes', match: 'eq_any', columns: ['d.court_code'] },
      { name: 'justice_kind', match: 'exact', columns: ['d.justice_kind'] },
      { name: 'military_category', match: 'eq_any', columns: ['d.category_code'] },
      { name: 'date_from', match: 'gte', columns: ['d.adjudication_date'] },
      { name: 'instance_code', match: 'exact', columns: ['c.instance_code'] },
    ];
    const r = buildWhere(fields, {
      judge: 'Коваль',
      court_codes: [991, 992],
      justice_kind: 2,
      military_category: [40851, 5459],
      date_from: '2026-01-01',
      instance_code: 1,
    });
    expect(r.whereClause).toBe(
      'd.judge ILIKE $1 AND d.court_code = ANY($2) AND d.justice_kind = $3 AND ' +
      'd.category_code = ANY($4) AND d.adjudication_date >= $5 AND c.instance_code = $6'
    );
    expect(r.values).toEqual(['%Коваль%', [991, 992], 2, [40851, 5459], '2026-01-01', 1]);
    expect(r.nextParamIndex).toBe(7); // next free $N → LIMIT
  });

  it('honors startParamIndex for composition with prior conditions', () => {
    const r = buildWhere(FIELDS, { name: 'x', edrpou: '12345678' }, { startParamIndex: 5 });
    expect(r.whereClause).toBe('name ILIKE $5 AND edrpou = $6');
    expect(r.nextParamIndex).toBe(7);
  });

  it('end-to-end: validated IR feeds the builder', () => {
    const parsed = parseCourtSearchIR({ judge: 'Петренко', justice_kind: 2 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const edrsrFields: FieldDef[] = [
      { name: 'judge', match: 'ilike', columns: ['d.judge'] },
      { name: 'justice_kind', match: 'exact', columns: ['d.justice_kind'], type: 'number' },
    ];
    const r = buildWhere(edrsrFields, parsed.value as Record<string, any>);
    expect(r.whereClause).toBe('d.judge ILIKE $1 AND d.justice_kind = $2');
    expect(r.values).toEqual(['%Петренко%', 2]);
  });
});

describe('query-ir / parseEdsrSearchArgs (tool-call boundary)', () => {
  it('accepts a valid structured search and keeps known fields', () => {
    const r = parseEdsrSearchArgs({
      mode: 'structured',
      judge: 'Петренко',
      justice_kind: 2,
      judgment_code: 1,
      date_from: '2023-01-01',
      party_role: 'defendant',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.mode).toBe('structured');
      expect(r.value.justice_kind).toBe(2);
      expect(r.value.party_role).toBe('defendant');
    }
  });

  it('rejects unknown (injected/unsupported) fields via .strict()', () => {
    const r = parseEdsrSearchArgs({ mode: 'fulltext', query: 'оренда', sql: 'DROP TABLE x', region: 'Kyiv' });
    expect(r.ok).toBe(false);
  });

  it('coerces stringified numerics ("2" -> 2)', () => {
    const r = parseEdsrSearchArgs({ mode: 'structured', justice_kind: '2', limit: '50' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.justice_kind).toBe(2);
      expect(r.value.limit).toBe(50);
    }
  });

  it('rejects out-of-range justice_kind', () => {
    const r = parseEdsrSearchArgs({ mode: 'structured', justice_kind: 99 });
    expect(r.ok).toBe(false);
  });

  it('rejects invalid judgment_code', () => {
    const r = parseEdsrSearchArgs({ mode: 'structured', judgment_code: 4 });
    expect(r.ok).toBe(false);
  });

  it('rejects a malformed date', () => {
    const r = parseEdsrSearchArgs({ mode: 'structured', date_from: 'вчора' });
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown mode', () => {
    const r = parseEdsrSearchArgs({ mode: 'magic' });
    expect(r.ok).toBe(false);
  });

  it('rejects an invalid party_role enum', () => {
    const r = parseEdsrSearchArgs({ mode: 'hybrid', query: 'x', party_role: 'judge' });
    expect(r.ok).toBe(false);
  });
});
