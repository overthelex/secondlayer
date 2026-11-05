/** Output fixes from the 04.11.2026 MCP audit (LEXAI-2194..2199). */
import { formatSpecialFormRow, formatTaxDebtRow } from '../openreyestr-tools';
import { deriveArmaStatusCategory } from '../../services/arma-mapping';
import { normalizeNazkRegion, nazkRegionCodesMatching } from '../../utils/nazk-region';
import { mapTerminationStarted, mapBankruptcyInfo } from '../../utils/nais-subrecords';

describe('special forms (LEXAI-2195)', () => {
  it('reports INS_DATE as register_entry_date, not issue_date', () => {
    const out: any = formatSpecialFormRow({ id: 1, series: 'НАЕ', form_number: '68904', issue_date: '2026-08-07', usage_date: '2014-08-28' });
    expect(out.issue_date).toBeUndefined();
    expect(out.register_entry_date).toBe('2026-08-07');
    expect(out.usage_date).toBe('2014-08-28');
  });
});

describe('tax debt (LEXAI-2194)', () => {
  it('replaces four null amounts with an explicit note', () => {
    const out: any = formatTaxDebtRow({ id: 1, name: 'X', debt_total: null, debt_state_budget: null, debt_local_budget: null });
    expect(out).not.toHaveProperty('debt_total');
    expect(out.debt_amounts).toBeNull();
    expect(out.debt_amounts_note).toMatch(/відсутні/);
  });
  it('keeps rows that do have amounts unchanged', () => {
    const row = { id: 1, debt_total: '10', debt_state_budget: '8', debt_local_budget: '2' };
    expect(formatTaxDebtRow(row)).toBe(row);
  });
});

describe('NAZK region (LEXAI-2196)', () => {
  it('maps dictionary codes to the region name', () => {
    expect(normalizeNazkRegion('1.2.80')).toBe('м. Київ');
    expect(normalizeNazkRegion('1.2.5')).toBe('Вінницька');
    expect(normalizeNazkRegion('Дніпропетровська')).toBe('Дніпропетровська');
    expect(normalizeNazkRegion('')).toBeNull();
  });
  it('finds codes for a region filter', () => {
    expect(nazkRegionCodesMatching('Київ')).toEqual(expect.arrayContaining(['32', '80']));
  });
});

describe('ARMA status_category (LEXAI-2199)', () => {
  it('derives the category from the court decision when there is no ARMA measure', () => {
    expect(deriveArmaStatusCategory({ status: null, decision_type: 'скасування арешту майна' })).toBe('returned');
    expect(deriveArmaStatusCategory({ status: null, decision_type: 'накладення арешту' })).toBe('arrested');
    expect(deriveArmaStatusCategory({ status: 'Реалізовано', decision_type: 'накладення арешту' })).toBe('sold');
    expect(deriveArmaStatusCategory({ status: null, decision_type: 'інше' })).toBeNull();
  });
});

describe('streaming parser sub-records (LEXAI-2198)', () => {
  it('maps uppercase XML tags to the importer columns', () => {
    expect(mapTerminationStarted({ OP_DATE: '01.02.2024', REASON: 'рішення засновників', SBJ_STATE: 'в стані припинення', SIGNER_NAME: 'Іваненко', CREDITOR_REQ_END_DATE: '01.04.2024' }))
      .toEqual({ op_date: '01.02.2024', reason: 'рішення засновників', sbj_state: 'в стані припинення', signer_name: 'Іваненко', creditor_req_end_date: '01.04.2024' });
    expect(mapBankruptcyInfo({ OP_DATE: 'x', BANKRUPTCY_READJUSTMENT_HEAD_NAME: 'Петренко' }).head_name).toBe('Петренко');
  });
});
