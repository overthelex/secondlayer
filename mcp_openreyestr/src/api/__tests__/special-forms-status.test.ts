import { formatSpecialFormRow, splitBlankState, specialFormStatusSql } from '../openreyestr-tools';

// LEXAI-2166: BLANK_STATE mixes the act a form was used for (1-16) with its condition (21-26).
describe('special forms status', () => {
  it('splits a usage code into status «використаний» and a clean document type', () => {
    expect(splitBlankState('15 - Договір про відчуження земельної ділянки')).toEqual({
      status: 'використаний', document_type: 'Договір про відчуження земельної ділянки', document_type_code: 15,
    });
  });

  it('reads codes 21-26 as the form condition', () => {
    expect(splitBlankState('21 - Зіпсований бланк')).toEqual({ status: 'зіпсований', document_type: null, document_type_code: 21 });
    expect(splitBlankState('25 - Викрадений бланк').status).toBe('викрадений');
  });

  it('fills status in the formatted row', () => {
    const out: any = formatSpecialFormRow({ id: 1, series: 'НОР', form_number: '1', document_type: '7 - Довіреність', status: null, usage_date: '2020-08-14' });
    expect(out.status).toBe('використаний');
    expect(out.document_type).toBe('Довіреність');
    expect(out.document_type_code).toBe(7);
  });

  it('builds a filter that matches the stored label', () => {
    expect(specialFormStatusSql('Викрадений', 4)).toEqual({ sql: 'document_type ILIKE $4', value: '%- Викрадений бланк' });
    const used = specialFormStatusSql('використаний', 1)!;
    expect(new RegExp(used.value).test('20 - x')).toBe(true);
    expect(new RegExp(used.value).test('21 - Зіпсований бланк')).toBe(false);
    expect(new RegExp(used.value).test('7 - Довіреність')).toBe(true);
    expect(specialFormStatusSql('чинний', 1)).toBeNull();
  });
});
