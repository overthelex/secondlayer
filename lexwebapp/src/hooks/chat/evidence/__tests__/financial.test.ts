import { describe, it, expect } from 'vitest';
import { extractFinancialEvidence } from '../financial';

const figures = [
  { key: 'total_assets', line: '1300', label: 'Активи (баланс)', current: 84939977, prior: 66444189 },
  { key: 'net_profit', line: '2350/2355', label: 'Чистий прибуток (збиток)', current: 12307536, prior: 11331462 },
];
const columns = {
  balance: { current: 'на кінець звітного періоду', prior: 'на початок звітного періоду' },
  income: { current: 'за звітний період', prior: 'за аналогічний період попереднього року' },
};

describe('extractFinancialEvidence', () => {
  it('maps search_registry filings with figures to right-panel documents', () => {
    const r = extractFinancialEvidence('search_registry', {
      results: [
        { tin: '21673832', form_type: 'S0100115', period_year: 2025, period_month: 12, period: 'рік 2025',
          form_name: 'Форма № 1', units: 'тис. грн', report_date: '2025-12-31', columns, figures, balance_check: true },
        { tin: '21673832', form_type: 'S0104010', period_year: 2025, period_month: 12, form_name: 'Форма № 4' },
      ],
    });
    expect(r.documents).toHaveLength(1);
    expect(r.documents[0].title).toBe('Фінансова звітність, рік 2025: Форма № 1');
    const snippet = r.documents[0].metadata!.snippet as string;
    expect(snippet).toContain('Активи (баланс) [р. 1300]');
    expect(snippet).toContain('на початок звітного періоду');
    expect(snippet).toContain('аналогічний період попереднього року');
  });

  it('maps the dossier latest figures; ignores other tools', () => {
    const r = extractFinancialEvidence('get_company_dossier', {
      edrpou: '21673832',
      sections: { financial_statements: { latest: { period: 'рік 2025', period_year: 2025, period_month: 12, units: 'тис. грн', columns, figures, source: 'Форма № 1 за рік 2025' } } },
    });
    expect(r.documents).toHaveLength(1);
    expect(r.documents[0].metadata!.snippet).toContain('Джерело: Форма № 1 за рік 2025');
    expect(extractFinancialEvidence('search_court_decisions', { results: [{ figures, form_type: 'x' }] }).documents).toHaveLength(0);
  });
});
