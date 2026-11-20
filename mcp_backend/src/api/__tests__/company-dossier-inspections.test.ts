import { CompanyDossierTool, SECTION_SPECS } from '../tools/company-dossier-tool.js';
import { INSPECTION_PLANS_SECTION } from '../tools/company-dossier-inspections.js';

const ok = (data: any) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

const ENTITY = { record: '1', edrpou: '41633007', name: 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "ХАЙБЕРРІ"', stan: 'зареєстровано', entity_type: 'UO' };

function registry(inspections: any) {
  const calls: Array<{ name: string; args: any }> = [];
  return {
    calls,
    executeTool: async (name: string, args: any) => {
      calls.push({ name, args });
      if (name === 'openreyestr_get_by_edrpou') return ok(ENTITY);
      if (name === 'openreyestr_get_data_freshness') {
        return ok({ inspection_plans: { as_of: '2026-03-23', basis: 'дата завантаження плану', note: 'Річний план, завантажений один раз.' } });
      }
      if (name === 'openreyestr_search_inspection_plans') return ok(inspections);
      return ok([]);
    },
  };
}

async function section(inspections: any) {
  const reg = registry(inspections);
  const res = await new CompanyDossierTool(reg).executeTool('get_company_dossier', { edrpou: '41633007' });
  const d = JSON.parse(res!.content[0].text);
  return { s: d.sections.inspection_plans, d, reg };
}

describe('get_company_dossier: «Заплановані перевірки» (LEXAI-2315)', () => {
  it('is a dossier section that asks the plans by ЄДРПОУ', async () => {
    expect(SECTION_SPECS).toContain(INSPECTION_PLANS_SECTION);
    const { reg } = await section([{ found: false, message: 'немає' }]);
    expect(reg.calls).toContainEqual({ name: 'openreyestr_search_inspection_plans', args: { edrpou: '41633007', limit: 50 } });
  });

  it('lists matched rows with the source date and the name-match caveat', async () => {
    const { s, d } = await section({
      edrpou: '41633007', match_basis: 'Збіг повної назви…', total_count: 2,
      results: [
        { id: 1, business_name: ENTITY.name, supervisory_body: 'Держпраці', start_date: '2026-02-10', duration_days: 10, plan_year: 2026 },
        { id: 2, business_name: ENTITY.name, supervisory_body: 'ДСНС', start_date: '2026-03-26', duration_days: 5, plan_year: 2026 },
      ],
    });
    expect(s).toMatchObject({ title: 'Заплановані перевірки', status: 'found', count: 2 });
    expect(s.source).toMatchObject({ tool: 'openreyestr_search_inspection_plans', as_of: '2026-03-23', as_of_basis: 'дата завантаження плану' });
    expect(s.source.note).toMatch(/немає коду ЄДРПОУ.*за повною назвою/);
    expect(s.source.note).toMatch(/завантажений один раз/);
    expect(s.items[0]).toMatchObject({ supervisory_body: 'Держпраці', start_date: '2026-02-10' });
    expect(d.facts).toContainEqual({ section: 'inspection_plans', fact: expect.stringMatching(/Заплановані перевірки: знайдено записів: 2/) });
  });

  it('shows an ambiguous name as no rows, keeping the explanation', async () => {
    const msg = 'Назва «ТОВ МРІЯ» є в планах перевірок (записів: 10), але таку саму назву в ЄДР мають ще інші чинні юрособи (95). … записи не показано.';
    const { s } = await section([{ found: false, ambiguous: true, plan_rows_with_name: 10, namesakes_live: 95, message: msg }]);
    expect(s).toMatchObject({ status: 'empty', count: 0, items: [], message: msg });
  });
});
