import {
  parseRepealNote,
  computeRepealedFrom,
  buildActStatus,
  buildStatusWarning,
  actStatusField,
  ActStatusResolver,
  REPEAL_NOTE_SQL_REGEX,
} from '../legislation-act-status';

// Real notes from npa.edition_text (prod, 31.10.2026), LEXAI-2147.
const GK_NOTE = '{Кодекс втратив чинність на підставі Закону № 4196-IX від 09.01.2025 }';
const INLINE_NOTE = '{ Закон втратив чинність на підставі Закону N 2427-VIII ( 2427-19 ) від 17.05.2018, ВВР, 2018, N 28, ст.232 }';
const KMU_NOTE = '{ Постанова втратила чинність на підставі Постанови КМ N 617 ( 617-2006-п ) від 11.05.2006 }';

describe('parseRepealNote', () => {
  it('extracts basis date and official number', () => {
    const n = parseRepealNote(GK_NOTE)!;
    expect(n.text).toBe('Кодекс втратив чинність на підставі Закону № 4196-IX від 09.01.2025');
    expect(n.basis_date).toBe('2025-01-09');
    expect(n.basis_number).toBe('4196-IX');
    expect(n.basis_rada_id).toBeUndefined();
  });

  it('extracts an inline registry id', () => {
    const n = parseRepealNote(INLINE_NOTE)!;
    expect(n.basis_rada_id).toBe('2427-19');
    expect(n.basis_date).toBe('2018-05-17');
    const k = parseRepealNote(KMU_NOTE)!;
    expect(k.basis_rada_id).toBe('617-2006-п');
  });

  it('returns null for empty input', () => {
    expect(parseRepealNote(null)).toBeNull();
    expect(parseRepealNote('')).toBeNull();
  });
});

describe('REPEAL_NOTE_SQL_REGEX', () => {
  it('has no capturing group (Postgres substring() would return the group, not the note)', () => {
    expect(REPEAL_NOTE_SQL_REGEX).not.toMatch(/(^|[^\\])\((?!\?)/);
  });
  it('matches the full note (checked with the JS engine)', () => {
    const re = new RegExp(REPEAL_NOTE_SQL_REGEX, 'u');
    const text = 'ГОСПОДАРСЬКИЙ КОДЕКС УКРАЇНИ\n' + GK_NOTE + '\n(Відомості ...)';
    expect(text.match(re)?.[0]).toBe(GK_NOTE);
  });
});

describe('computeRepealedFrom', () => {
  it('takes the final edition date when it is later than the repealing act (ГК)', () => {
    expect(computeRepealedFrom('2025-08-28', '2025-01-09')).toBe('2025-08-28');
  });
  it('takes the repealing act date when the last edition with text is older (1098-99-п)', () => {
    expect(computeRepealedFrom('1999-06-22', '2006-05-11')).toBe('2006-05-11');
  });
  it('handles a missing side', () => {
    expect(computeRepealedFrom('2020-01-01', undefined)).toBe('2020-01-01');
    expect(computeRepealedFrom(null, '2020-01-01')).toBe('2020-01-01');
    expect(computeRepealedFrom(null, null)).toBeUndefined();
  });
});

describe('buildActStatus / buildStatusWarning', () => {
  const gk = buildActStatus({ nreg: '436-15', status_code: 1, last_ed: '2025-08-28', repeal_note: GK_NOTE });

  it('marks ГК as repealed with date, basis and the ЦК successor', () => {
    expect(gk.repealed).toBe(true);
    expect(gk.in_force).toBe(false);
    expect(gk.status).toBe('Втратив чинність');
    expect(gk.repealed_from).toBe('2025-08-28');
    expect(gk.successors).toEqual([{ rada_id: '435-15', title: 'Цивільний кодекс України' }]);
  });

  it('builds a Ukrainian warning with date and pointer', () => {
    const w = buildStatusWarning(gk)!;
    expect(w).toContain('Акт втратив чинність з 28.08.2025');
    expect(w).toContain('4196-IX');
    expect(w).toContain('НЕ чинна норма');
    expect(w).toContain('Див. Цивільний кодекс України (435-15)');
  });

  it('softens the warning for an edition requested before the repeal', () => {
    const w = buildStatusWarning(gk, '2024-01-01')!;
    expect(w).toContain('станом на 01.01.2024');
    expect(w).not.toContain('НЕ чинна норма');
  });

  it('points at the repealing act when no curated successor exists', () => {
    const s = buildActStatus({ nreg: '1007-14', status_code: 1, last_ed: '2019-01-01', repeal_note: INLINE_NOTE });
    expect(buildStatusWarning(s)).toContain('Див. акт, яким скасовано (2427-19)');
  });

  it('labels status 9 as partially repealed', () => {
    const s = buildActStatus({ nreg: 'x', status_code: 9, last_ed: '2020-01-01', repeal_note: null });
    expect(s.repealed).toBe(true);
    expect(buildStatusWarning(s)).toContain('втратив чинність, крім окремих положень, з 01.01.2020');
  });

  it('gives no warning for an act in force, and a caveat for a suspended one', () => {
    const ck = buildActStatus({ nreg: '435-15', status_code: 5, last_ed: '2026-08-05' });
    expect(ck.in_force).toBe(true);
    expect(buildStatusWarning(ck)).toBeUndefined();
    expect(actStatusField(ck)).toEqual({ status: 'Чинний', in_force: true });
    const suspended = buildActStatus({ nreg: 'y', status_code: 3 });
    expect(buildStatusWarning(suspended)).toContain('Дію акта зупинено');
  });
});

describe('ActStatusResolver', () => {
  function db(rows: any[], numberRows: any[] = []) {
    return {
      query: jest.fn(async (sql: string) =>
        sql.includes('npa.act_number') ? { rows: numberRows } : { rows }
      ),
    } as any;
  }

  it('batches, lower-cases and caches lookups', async () => {
    const d = db([
      { nreg: '436-15', status_code: 1, last_ed: '2025-08-28', repeal_note: GK_NOTE },
      { nreg: '435-15', status_code: 5, last_ed: '2026-08-05', repeal_note: null },
    ], [{ nreg: '4196-20', kind: 'official', alias_raw: '4196-IX', confidence: 1 }]);
    const r = new ActStatusResolver(d);
    const m = await r.getStatuses(['436-15', '435-15', '435-15', null]);
    expect(m.get('436-15')?.repealed).toBe(true);
    expect(m.get('436-15')?.repealed_by_rada_id).toBe('4196-20');
    expect(m.get('435-15')?.in_force).toBe(true);
    const actQueries = () => d.query.mock.calls.filter((c: any[]) => c[0].includes('FROM npa.act a')).length;
    expect(actQueries()).toBe(1);
    expect(d.query.mock.calls[0][1][0]).toEqual(['436-15', '435-15']);

    await r.getStatuses(['436-15', 'unknown-1']);
    await r.getStatuses(['unknown-1']);
    // 436-15 cached; unknown-1 fetched once, then negatively cached.
    expect(actQueries()).toBe(2);
  });

  it('returns an empty map when the npa schema is unavailable', async () => {
    const d = { query: jest.fn().mockRejectedValue(new Error('relation "npa.act" does not exist')) } as any;
    const m = await new ActStatusResolver(d).getStatuses(['436-15']);
    expect(m.size).toBe(0);
  });
});
