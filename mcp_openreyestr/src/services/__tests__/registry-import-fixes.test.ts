import iconv from 'iconv-lite';
import { detectXmlEncoding } from '../generic-xml-importer';
import { REGISTRIES } from '../../config/registries';
import {
  parseNazkDate, extractDeclarantInfo, resolveNazkPostLabel, parseNazkAmount, isCorruptionAffected,
  NAZK_POST_TYPE_LABELS, NAZK_POST_CATEGORY_LABELS,
} from '../../scripts/import-nazk-declarations';

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

  // Shapes copied from public-api.nazk.gov.ua/v2/documents/{id}, 24.10.2026.
  const listItem = {
    id: 'bed01007-5a3b-4e1e-bd60-8c07a1d1bc7f', corruption_affected: 2, post_type: 2, post_category: 10,
    date: '2026-10-24T14:16:36+03:00',
    data: {
      step_0: { data: { declarationType: '1' } },
      step_1: { data: {
        lastname: 'ЖЕЛЕЗНЯК', firstname: 'ІГОР', middlename: 'ВІКТОРОВИЧ', workPost: 'начальник відділу',
        workPlace: 'Пенсійний фонд', postType: 'Посада державної служби', postCategory: 'В', corruptionAffected: 'Ні',
      } },
    },
  };

  it('takes the position from step_1.workPost and post labels from step_1', () => {
    const info = extractDeclarantInfo(listItem);
    expect(info.name).toBe('ЖЕЛЕЗНЯК ІГОР ВІКТОРОВИЧ');
    expect(info.position).toBe('начальник відділу');
    expect(info.postType).toBe('Посада державної служби');
    expect(info.postCategory).toBe('В');
    expect(info.corruptionAffected).toBe(false);
    expect(info.hasIncome).toBeNull();
  });

  it('maps numeric post codes to labels when step_1 says "not applicable"', () => {
    expect(resolveNazkPostLabel('[Не застосовується]', 3, NAZK_POST_TYPE_LABELS)).toBe('Посада в органах місцевого самоврядування');
    expect(resolveNazkPostLabel('[Не застосовується]', 6, NAZK_POST_CATEGORY_LABELS)).toBe('шоста категорія');
    expect(resolveNazkPostLabel('[Не застосовується]', 0, NAZK_POST_TYPE_LABELS)).toBe('[Не застосовується]');
    expect(resolveNazkPostLabel(undefined, 99, NAZK_POST_TYPE_LABELS)).toBe('99');
    expect(resolveNazkPostLabel('Політична посада', 0, NAZK_POST_TYPE_LABELS)).toBe('Політична посада');
  });

  it('reads corruption_affected as 1 = yes, 2 = no, else the step_1 answer', () => {
    expect(isCorruptionAffected(1, 'Так')).toBe(true);
    expect(isCorruptionAffected(2, 'Ні')).toBe(false);
    expect(isCorruptionAffected(0, 'Міський (міста районного значення) голова, селищний і сільський голова')).toBe(true);
    expect(isCorruptionAffected(0, undefined)).toBe(false);
  });

  it('parses income amounts and ignores placeholders', () => {
    expect(parseNazkAmount('25668')).toBe(25668);
    expect(parseNazkAmount('12 345,67')).toBe(12345.67);
    expect(parseNazkAmount('[Не відомо]')).toBeNull();
    expect(parseNazkAmount(undefined)).toBeNull();
  });

  it('derives flags and total income from a full document', () => {
    const doc = {
      ...listItem,
      data: {
        ...listItem.data,
        step_3: { data: [{ objectType: 'Квартира' }], isNotApplicable: 0 },
        step_6: { data: [], isNotApplicable: 1 },
        step_7: { data: [], isNotApplicable: 1 },
        step_8: { data: [], isNotApplicable: 0 },
        step_11: { data: [
          { person: '1', sizeIncome: '25668', objectType: 'Пенсія' },
          { person: '1489398567440', sizeIncome: '33600.50', objectType: 'Заробітна плата' },
          { person: '1', sizeIncome: '[Не відомо]' },
        ], isNotApplicable: 0 },
      },
    };
    const info = extractDeclarantInfo(doc);
    expect(info.hasRealEstate).toBe(true);
    expect(info.hasVehicles).toBe(false);
    expect(info.hasSecurities).toBe(false);
    expect(info.hasCorporateRights).toBe(false);
    expect(info.hasIncome).toBe(true);
    expect(info.totalIncome).toBe(59268.5);
  });

  it('reports no income as 0 when section 11 is marked not applicable', () => {
    const info = extractDeclarantInfo({ data: { step_11: { data: [], isNotApplicable: 1 } } });
    expect(info.hasIncome).toBe(false);
    expect(info.totalIncome).toBe(0);
  });
});
