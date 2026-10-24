import iconv from 'iconv-lite';
import { detectXmlEncoding } from '../generic-xml-importer';
import { REGISTRIES } from '../../config/registries';
import { parseNazkDate, extractDeclarantInfo } from '../../scripts/import-nazk-declarations';

describe('detectXmlEncoding', () => {
  const body = '<DATA><RECORD><FIO>Чернишова Вікторія Валеріївна</FIO></RECORD></DATA>';

  it('reads UTF-8 without a prolog as UTF-8 even when the config says windows-1251', () => {
    expect(detectXmlEncoding(Buffer.from(body, 'utf-8'), 'windows-1251')).toBe('utf-8');
  });

  it('keeps windows-1251 for a cp1251 file without a prolog', () => {
    expect(detectXmlEncoding(iconv.encode(body, 'windows-1251'), 'windows-1251')).toBe('windows-1251');
  });

  it('trusts the prolog', () => {
    const head = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="windows-1251"?>'), iconv.encode(body, 'windows-1251')]);
    expect(detectXmlEncoding(head, 'utf-8')).toBe('windows-1251');
  });

  it('tolerates a multi-byte character cut at the end of the head', () => {
    const buf = Buffer.from(body, 'utf-8');
    const cut = buf.subarray(0, buf.indexOf(Buffer.from('ї', 'utf-8')) + 1);
    expect(detectXmlEncoding(cut, 'windows-1251')).toBe('utf-8');
  });
});

describe('bankruptcy_cases fieldMap', () => {
  it('maps the tags the file actually has', () => {
    const map = REGISTRIES.bankruptcy_cases.fieldMap;
    expect(map.registration_number).toBe('RN_NUM');
    expect(map.debtor_name).toBe('NAME');
    const status = map.proceeding_status as (v: string, r: Record<string, unknown>) => unknown;
    expect(status('', { PROC_BORG_NAME: 'Ліквідація', STAN_PROV: '(Не визначено), звіт затверджено' }))
      .toBe('Ліквідація: (Не визначено), звіт затверджено');
    expect(status('', { PROC_BORG_NAME: 'Розпорядження майном', STAN_PROV: ',' })).toBe('Розпорядження майном');
    expect(status('', {})).toBeNull();
  });
});

describe('NAZK import', () => {
  it('parses the ISO date the API sends', () => {
    expect(parseNazkDate('2026-10-23T21:43:05+03:00')).toBe('2026-10-23T18:43:05.000Z');
    expect(parseNazkDate(1700000000)).toBe('2023-11-14T22:13:20.000Z');
    expect(parseNazkDate('2026')).toBeNull();
    expect(parseNazkDate('')).toBeNull();
  });

  it('reports sections missing from the list response as unknown, not false', () => {
    const info = extractDeclarantInfo({ data: { step_1: { data: { lastname: 'Шевченко' } } } });
    expect(info.hasRealEstate).toBeNull();
    expect(info.hasIncome).toBeNull();
    expect(info.totalIncome).toBeNull();
    const full = extractDeclarantInfo({ data: { step_3: { data: {} }, step_11: { data: { a: { sizeIncome: '100' } } } } });
    expect(full.hasRealEstate).toBe(false);
    expect(full.hasIncome).toBe(true);
    expect(full.totalIncome).toBe(100);
  });
});
