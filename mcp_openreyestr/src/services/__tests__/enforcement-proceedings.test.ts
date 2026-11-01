import type { Pool } from 'pg';
import { REGISTRIES } from '../../config/registries';
import { OpenReyestrTools } from '../../api/openreyestr-tools';
import { MIN_OPENING_DATE, maxOpeningDate, parseOpeningDate } from '../../utils/enforcement';
import { isUniqueKeyIndex, uniqueKeyColumns } from '../unique-key-load';

const NOW = new Date('2026-11-01T12:00:00Z');
const cfg = REGISTRIES.enforcement_proceedings;

/** A row from the АСВП CSV as the importer sees it (header of 2026-10-29). */
function asvpRow(over: Record<string, string> = {}): Record<string, string> {
  return {
    DEBTOR_NAME: 'Рева Олександр Іванович',
    DEBTOR_BIRTHDATE: '03.03.1976 00:00:00',
    DEBTOR_CODE: '',
    CREDITOR_NAME: 'Рева Ганна Петрівна',
    CREDITOR_CODE: '',
    VP_ORDERNUM: '5713939',
    VP_BEGINDATE: '21.12.2009 00:00:00',
    VP_STATE: 'Відкрито',
    ORG_NAME: 'Корабельний відділ ДВС',
    DVS_CODE: '35007146',
    PHONE_NUM: '',
    EMAIL_ADDR: '',
    BANK_ACCOUNT: '',
    ...over,
  };
}

function mapField(column: string, record: Record<string, string>): unknown {
  const m = cfg.fieldMap[column];
  return typeof m === 'function' ? m(record[column] ?? '', record) : record[m];
}

describe('LEXAI-2163: enforcement opening_date', () => {
  it('parses dd.mm.yyyy[ HH:MM:SS]', () => {
    expect(parseOpeningDate('21.12.2009 00:00:00', NOW)).toBe('2009-12-21');
    expect(parseOpeningDate(' 29.10.2026', NOW)).toBe('2026-10-29');
  });

  it('drops the mistyped years seen in the source', () => {
    for (const raw of ['21.12.2209 00:00:00', '21.12.2207 00:00:00', '25.05.5005 00:00:00',
      '29.07.8209 00:00:00', '01.10.9008 00:00:00', '06.11.1958 00:00:00', '01.01.2028 00:00:00']) {
      expect(parseOpeningDate(raw, NOW)).toBeNull();
    }
  });

  it('bounds: 1990-01-01 .. tomorrow', () => {
    expect(MIN_OPENING_DATE).toBe('1990-01-01');
    expect(maxOpeningDate(NOW)).toBe('2026-11-02');
    expect(parseOpeningDate('01.01.1990', NOW)).toBe('1990-01-01');
    expect(parseOpeningDate('31.12.1989', NOW)).toBeNull();
    expect(parseOpeningDate('02.11.2026', NOW)).toBe('2026-11-02');
    expect(parseOpeningDate('03.11.2026', NOW)).toBeNull();
  });

  it('rejects empty, malformed and impossible calendar dates', () => {
    expect(parseOpeningDate('', NOW)).toBeNull();
    expect(parseOpeningDate(null, NOW)).toBeNull();
    expect(parseOpeningDate('2009-12-21', NOW)).toBeNull();
    expect(parseOpeningDate('31.02.2010', NOW)).toBeNull();
    expect(parseOpeningDate('00.13.2010', NOW)).toBeNull();
    expect(parseOpeningDate('21.12.20091', NOW)).toBeNull();
  });

  it('the registry maps VP_BEGINDATE through the range check', () => {
    expect(mapField('opening_date', asvpRow())).toBe('2009-12-21');
    expect(mapField('opening_date', asvpRow({ VP_BEGINDATE: '21.12.2209 00:00:00' }))).toBeNull();
  });

  it('no longer maps the non-existent EXECUTOR_NAME column', () => {
    expect(cfg.fieldMap.executor_name).toBeUndefined();
  });
});

describe('LEXAI-2163: search_enforcement_proceedings SQL', () => {
  function tools() {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: '1', proceeding_number: '5713939' }] });
    return { t: new OpenReyestrTools({ query } as unknown as Pool), query };
  }

  it('masks implausible dates, orders by the index, takes executor from debtors per page', async () => {
    const { t, query } = tools();
    await t.searchEnforcementProceedings({ proceeding_status: 'Відкрито', limit: 3 });
    const [sql, values] = query.mock.calls[0];
    const plausible =
      "CASE WHEN ep.opening_date >= DATE '1990-01-01' AND ep.opening_date <= (now() AT TIME ZONE 'UTC')::date + 1 THEN ep.opening_date END";
    expect(sql).toContain(`${plausible} AS opening_date`);
    // ordering on the raw column (idx_enforce_opening_desc), never on the CASE
    expect(sql).not.toContain(`ORDER BY ${plausible}`);
    expect(sql).toMatch(
      /FROM \(\s*SELECT \* FROM enforcement_proceedings ep\s+WHERE ep\.proceeding_status ILIKE \$1\s+ORDER BY ep\.opening_date DESC NULLS LAST, ep\.id DESC\s+LIMIT \$2 OFFSET \$3\s*\) ep/
    );
    // executor lookup after the page is cut, deterministic
    expect(sql).toMatch(
      /\) ep\s+LEFT JOIN LATERAL \(\s*SELECT debtors\.executor_name FROM debtors\s+WHERE debtors\.proceeding_number = ep\.proceeding_number AND debtors\.executor_name IS NOT NULL\s+ORDER BY debtors\.id DESC\s+LIMIT 1/
    );
    expect(sql).toContain('COALESCE(ep.executor_name, d.executor_name) AS executor_name');
    expect(sql).toContain('ep.proceeding_status ILIKE $1');
    expect(values).toEqual(['%Відкрито%', 3, 0]);
  });

  it('qualifies every filter with the ep alias (debtors shares column names)', async () => {
    const { t, query } = tools();
    await t.searchEnforcementProceedings({ query: 'Рева', debtor_edrpou: '20077720', creditor_name: 'ПРИВАТБАНК' });
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain("to_tsvector('simple', ep.debtor_name) @@ plainto_tsquery('simple', $1)");
    expect(sql).toContain('ep.debtor_edrpou = $2');
    expect(sql).toContain("to_tsvector('simple', ep.creditor_name) @@ plainto_tsquery('simple', $3)");
    expect(values).toEqual(['Рева', '20077720', 'ПРИВАТБАНК', 50, 0]);
  });
});

describe('LEXAI-2144: enforcement natural key', () => {
  it('upserts on reload on proceeding_number', () => {
    expect(cfg.upsertOnReload).toBe(true);
    expect(uniqueKeyColumns(cfg)).toEqual(['proceeding_number']);
  });

  it('accepts the migration 022 index and nothing weaker', () => {
    const key = uniqueKeyColumns(cfg);
    expect(isUniqueKeyIndex(
      'CREATE UNIQUE INDEX enforcement_proceedings_number_uniq ON public.enforcement_proceedings USING btree (proceeding_number) NULLS NOT DISTINCT',
      key
    )).toBe(true);
    // the 004 constraint index and the plain index
    expect(isUniqueKeyIndex(
      'CREATE UNIQUE INDEX enforcement_proceedings_proceeding_number_key ON public.enforcement_proceedings USING btree (proceeding_number)',
      key
    )).toBe(false);
    expect(isUniqueKeyIndex(
      'CREATE INDEX idx_enforce_number ON public.enforcement_proceedings USING btree (proceeding_number)',
      key
    )).toBe(false);
  });
});
