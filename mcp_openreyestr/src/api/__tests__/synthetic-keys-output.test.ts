import { Pool } from 'pg';
import { REGISTRIES } from '../../config/registries';
import { fillMissingUniqueKeys, notSyntheticSql, nullSyntheticKeys } from '../../services/synthetic-keys';
import {
  OpenReyestrTools,
  formatAdministrativeUnitRow,
  formatBankruptcyRow,
  formatCourtExpertRow,
  formatForensicMethodRow,
  formatSpecialFormRow,
  formatStreetRow,
} from '../openreyestr-tools';

function mockPool(rows: any[]) {
  const query = jest.fn().mockResolvedValue({ rows });
  return { pool: { query } as unknown as Pool, query };
}

const GEN = /^gen_\d+$/;

/** No value anywhere in the tool output may be a gen_N surrogate. */
function expectNoSurrogate(rows: any[]) {
  for (const row of rows) {
    for (const v of Object.values(row)) expect(typeof v === 'string' && GEN.test(v)).toBe(false);
  }
}

describe('LEXAI-2129: gen_N surrogate keys never reach tool output', () => {
  it('nullSyntheticKeys nulls only the listed surrogate columns', () => {
    const out = nullSyntheticKeys({ a: 'gen_5', b: 'gen_6', c: 'real' }, ['a', 'c']);
    expect(out).toEqual({ a: null, b: 'gen_6', c: 'real' });
  });

  it('notSyntheticSql builds a regex predicate on the column', () => {
    expect(notSyntheticSql('series')).toBe(`series !~ '^gen_[0-9]+$'`);
  });

  it('court experts: expert_id gen_N → null, real id kept', async () => {
    expect(formatCourtExpertRow({ expert_id: '1698', full_name: 'X' }).expert_id).toBe('1698');
    const { pool } = mockPool([
      { id: 1, expert_id: 'gen_3656', full_name: 'дубіневич вікторія володимирівна' },
      { id: 2, expert_id: '003517', full_name: 'Аль-Тайаві яна анатоліївна' },
    ]);
    const res = await new OpenReyestrTools(pool).searchCourtExperts({ query: 'а' });
    expect(res[0].expert_id).toBeNull();
    expect(res[1].expert_id).toBe('003517');
    expectNoSurrogate(res);
  });

  it('special forms: drops legacy gen_N duplicates in SQL and nulls any left', async () => {
    expect(formatSpecialFormRow({ series: 'gen_68137', form_number: 'gen_68137' })).toEqual({ series: null, form_number: null });
    const { pool, query } = mockPool([{ id: 1, series: 'НКЕ', form_number: '926652', recipient: 'Білоконь О.М.' }]);
    const res = await new OpenReyestrTools(pool).searchSpecialForms({ recipient: 'Білоконь', limit: 5 });
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain(`series !~ '^gen_[0-9]+$'`);
    expect(sql).toMatch(/LIMIT \$2 OFFSET \$3/);
    expect(values).toEqual(['%Білоконь%', 5, 0]);
    expect(res[0]).toMatchObject({ series: 'НКЕ', form_number: '926652' });
  });

  it('forensic methods: code and name come from raw_data when the column has gen_N / is empty', async () => {
    const { pool, query } = mockPool([
      { id: 1, registration_code: 'gen_2', method_name: null, raw_code: '2.1.10', raw_method_name: 'Встановлення внесення в текст дописок' },
      { id: 2, registration_code: 'gen_3', method_name: '', raw_code: '', raw_method_name: '' },
    ]);
    const res = await new OpenReyestrTools(pool).searchForensicMethods({ query: 'дописок' });
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/COALESCE\(NULLIF\(method_name, ''\), raw_data->>'MET_NAME', ''\)/);
    expect(sql).toMatch(/raw_data->>'MET_CODE' AS raw_code/);
    expect(res[0]).toEqual({ id: 1, registration_code: '2.1.10', method_name: 'Встановлення внесення в текст дописок' });
    expect(res[1]).toEqual({ id: 2, registration_code: null, method_name: null });
    expectNoSurrogate(res);
  });

  it('forensic methods: a real code and name are kept as they are', () => {
    expect(formatForensicMethodRow({ registration_code: '8.4.02', method_name: 'A', raw_code: 'X', raw_method_name: 'B' }))
      .toEqual({ registration_code: '8.4.02', method_name: 'A' });
  });

  it('administrative units: koatuu gen_N → null, md5 key kept', async () => {
    expect(formatAdministrativeUnitRow({ koatuu: '14b47f707dcf92055eee72ea6900fffb' }).koatuu).toBe('14b47f707dcf92055eee72ea6900fffb');
    const { pool } = mockPool([{ id: 1, koatuu: 'gen_3233', settlement_name: 'м.Керч' }]);
    const res = await new OpenReyestrTools(pool).searchAdministrativeUnits({ query: 'Керч' });
    expect(res[0].koatuu).toBeNull();
    expectNoSurrogate(res);
  });

  it('streets: street_type and street_name gen_N → null', async () => {
    expect(formatStreetRow({ street_type: 'вул', street_name: 'вул.Сонячна' })).toEqual({ street_type: 'вул', street_name: 'вул.Сонячна' });
    const { pool } = mockPool([
      { id: 1, street_id: null, street_type: 'gen_264', street_name: 'вул.Чубинського' },
      { id: 2, street_id: null, street_type: 'gen_54329', street_name: 'gen_54329' },
    ]);
    const res = await new OpenReyestrTools(pool).searchStreets({ region: 'Волинська' });
    expect(res[0]).toMatchObject({ street_type: null, street_name: 'вул.Чубинського' });
    expect(res[1]).toMatchObject({ street_type: null, street_name: null });
    expectNoSurrogate(res);
  });

  it('bankruptcy: drops legacy gen_N duplicates in SQL and nulls registration_number', async () => {
    expect(formatBankruptcyRow({ registration_number: 'gen_706' }).registration_number).toBeNull();
    expect(formatBankruptcyRow({ registration_number: '44142' }).registration_number).toBe('44142');
    const { pool, query } = mockPool([]);
    await new OpenReyestrTools(pool).searchBankruptcyCases({ query: 'Македони', limit: 20 });
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain(`registration_number !~ '^gen_[0-9]+$'`);
    expect(sql).toMatch(/LIMIT \$2 OFFSET \$3\s*\) b/);
    expect(values).toEqual(['Македони', 20, 0]);
  });
});

describe('LEXAI-2129: forensic_methods field map reads the tags the file has', () => {
  const record = {
    MET_CODE: '5.1.06', MET_NAME: 'Визначення стабільності бездимних порохів', EXP_TYPE: 'Вибухово-технічна експертиза',
    YEAR: '1950, 1973', NOTES: 'ВНИИСЭ 1978', REGISTER_DATE: '2009-02-06', REGISTER_DATE_STOP: '28.01.2022',
  };
  const map = REGISTRIES.forensic_methods.fieldMap;
  const apply = (col: string) => {
    const m = map[col];
    return typeof m === 'function' ? m('', record) : (record as Record<string, unknown>)[m];
  };

  it('maps name, year, date, notes and status', () => {
    expect(apply('method_name')).toBe('Визначення стабільності бездимних порохів');
    expect(apply('year_created')).toBe(1950);
    expect(apply('registration_date')).toBe('2009-02-06');
    expect(apply('registration_info')).toBe('ВНИИСЭ 1978');
    expect(apply('status')).toBe('stopped');
    const yearFn = map.year_created as (v: string, r: Record<string, unknown>) => unknown;
    expect(yearFn('', { YEAR: '' })).toBeNull();
    const statusFn = map.status as (v: string, r: Record<string, unknown>) => unknown;
    expect(statusFn('', { REGISTER_DATE_STOP: '' })).toBe('active');
  });

  it('keeps a surrogate key: MET_CODE repeats across distinct methods', () => {
    const mapped: Record<string, unknown> = { registration_code: apply('registration_code') };
    fillMissingUniqueKeys(REGISTRIES.forensic_methods, mapped, 12);
    expect(mapped.registration_code).toBe('gen_12');
  });
});
