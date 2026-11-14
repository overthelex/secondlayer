import { CompanyDossierTool, isPlaceholderEmail, normEdr, ROW_FIELDS, partyNameFor, registrationDate, SECTION_SPECS, toRows, trimRow } from '../tools/company-dossier-tool.js';

const ok = (data: any) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }] });

const ENTITY = {
  record: '1000123', edrpou: '41633007', name: 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "КОМПАНІЯ МАСШТАБ БУД"',
  short_name: 'ТОВ "КОМПАНІЯ МАСШТАБ БУД"', stan: 'зареєстровано', registration: '12.09.2017 1 074 102 0000 012345',
  entity_type: 'UO', raw_data: { huge: true },
};

function registry(overrides: Record<string, (args: any) => any> = {}) {
  const calls: Array<{ name: string; args: any }> = [];
  const handlers: Record<string, (args: any) => any> = {
    openreyestr_get_by_edrpou: () => ok(ENTITY),
    openreyestr_get_entity_details: () => ok({
      founders: [{ founder_info: 'Іваненко Іван, 100%' }], beneficiaries: [{ beneficiary_info: 'Іваненко Іван' }], signers: [],
      addressAndActivity: { address: 'м. Кропивницький', kved: '41.20', reportYear: 2025 },
    }),
    openreyestr_get_data_freshness: () => ok({
      legal_entities: { as_of: '2026-11-05', basis: 'остання зміна запису при імпорті ЄДР' },
      tax_debt: { as_of: '2022-02-22', basis: 'дата звіту ДПС', note: 'зріз станом на 22.02.2022' },
      prozorro_contracts: { as_of: '2026-11-13', basis: 'остання синхронізація', note: 'за всю історію' },
    }),
    openreyestr_search_prozorro: (a) => {
      if (a.supplier_edrpou) return ok([
        { tender_id: 't1', supplier_edrpou: '41633007', supplier_phone: '380977009263', supplier_email: 'a@b.ua', contract_amount: '2707774.00' },
        { tender_id: 't2', supplier_edrpou: '41633007', supplier_phone: '380977009263', contract_amount: '100.00' },
      ]);
      if (a.supplier_phone) return ok([
        { supplier_edrpou: '41633007', supplier_name: 'МАСШТАБ' },
        { supplier_edrpou: '30287372', supplier_name: 'ДЕЛЬТА-98', buyer_edrpou: '04053915', buyer_name: 'Овруцька міська рада' },
        { supplier_edrpou: '30287372', supplier_name: 'ДЕЛЬТА-98', buyer_edrpou: '04053915', buyer_name: 'Овруцька міська рада' },
        // the same supplier and buyer, zero-padded by another platform: not a second company
        { supplier_edrpou: '0030287372', supplier_name: 'ДЕЛЬТА-98', buyer_edrpou: '0004053915', buyer_name: 'Овруцька міська рада' },
        { supplier_edrpou: '0041633007', supplier_name: 'МАСШТАБ' },
      ]);
      if (a.supplier_email) return ok([{ supplier_edrpou: '41633007' }]);
      return ok([{ found: false, message: 'Тендерів не знайдено' }]);
    },
    openreyestr_search_debtors: () => ok([{ found: false, message: 'Боржника не знайдено' }]),
    openreyestr_search_tax_debt: () => ({ content: [{ type: 'text', text: 'Error: boom' }], isError: true }),
    search_registry: (a) => (a.registry === 'construction_documents'
      ? ok({ results: [{ application_id: 'X', raw: { big: 1 } }], total_count: 7 })
      : ok('За вказаними параметрами записів не знайдено.')),
    count_cases_by_party: () => ok({ party_name: 'КОМПАНІЯ МАСШТАБ БУД', total_cases: 3, total_documents: 8 }),
    ...overrides,
  };
  return {
    calls,
    executeTool: async (name: string, args: any) => {
      calls.push({ name, args });
      const h = handlers[name];
      return h ? h(args) : ok([]);
    },
  };
}

async function dossier(reg = registry()) {
  const res = await new CompanyDossierTool(reg).executeTool('get_company_dossier', { edrpou: '41633007' });
  return { d: JSON.parse(res!.content[0].text), reg };
}

describe('get_company_dossier (LEXAI-2227)', () => {
  it('rejects anything that is not an 8-digit ЄДРПОУ and explains FOP codes', async () => {
    const tool = new CompanyDossierTool(registry());
    const bad = JSON.parse((await tool.executeTool('get_company_dossier', { edrpou: '123' }))!.content[0].text);
    expect(bad.error).toMatch(/8-значний/);
    const fop = JSON.parse((await tool.executeTool('get_company_dossier', { edrpou: '1234567890' }))!.content[0].text);
    expect(fop.error).toMatch(/ФОП/);
    expect(await tool.executeTool('other_tool', {})).toBeNull();
  });

  it('builds the ЄДР block with source, as-of date and record details', async () => {
    const { d } = await dossier();
    expect(d.entity.status).toBe('found');
    expect(d.entity.registration_date).toBe('2017-09-12');
    expect(d.entity.founders).toEqual(['Іваненко Іван, 100%']);
    expect(d.entity.source).toMatchObject({ tool: 'openreyestr_get_by_edrpou', as_of: '2026-11-05' });
    expect(d.entity.address_and_activity.source.as_of).toBe('звіт за 2025 рік');
    expect(d.entity).not.toHaveProperty('raw_data');
  });

  it('gives every section a source, and never shows a failed call as "nothing found"', async () => {
    const { d } = await dossier();
    for (const spec of SECTION_SPECS) {
      expect(d.sections[spec.key]).toBeDefined();
      expect(d.sections[spec.key].source.name).toBeTruthy();
    }
    expect(d.sections.tax_debt.status).toBe('error');
    expect(d.sections.tax_debt.message).toMatch(/невідомий/);
    expect(d.sections.tax_debt.source.note).toMatch(/22\.02\.2022/);
    expect(d.sections.debtors.status).toBe('empty');
    expect(d.sections.construction).toMatchObject({ status: 'found', count: 7 });
    expect(d.sections.construction.items[0]).not.toHaveProperty('raw');
    expect(d.sections.construction.source.note).toMatch(/2022/);
    expect(d.facts.some((f: any) => f.section === 'tax_debt' && /не відповіло/.test(f.fact))).toBe(true);
    // a found fact carries the source's as-of date, so a 2022 snapshot is not read as today
    expect(d.facts.find((f: any) => f.section === 'prozorro_supplier').fact).toMatch(/станом на 2026-11-13/);
  });

  it('reports a phone shared with another ProZorro supplier as a fact, not a verdict', async () => {
    const { d, reg } = await dossier();
    expect(d.markers).toHaveLength(1);
    expect(d.markers[0]).toMatchObject({ marker: 'shared_phone', other_suppliers: [{ edrpou: '30287372', name: 'ДЕЛЬТА-98' }] });
    expect(d.markers[0].fact).toMatch(/380977009263.*1 іншого постачальника/);
    expect(d.markers[0].fact).not.toMatch(/фіктив/i);
    // all matches come from one buyer: say so, and warn that the buyer may have typed its own contact
    expect(d.markers[0].fact).toMatch(/один замовник: Овруцька міська рада \(04053915\)/);
    expect(d.markers[0].distinct_buyers).toBe(1);
    expect(d.markers[0].caveat).toMatch(/вносить замовник/);
    // one probe per distinct phone and email
    expect(reg.calls.filter((c) => c.name === 'openreyestr_search_prozorro' && c.args.supplier_phone)).toHaveLength(1);
    expect(reg.calls.filter((c) => c.name === 'openreyestr_search_prozorro' && c.args.supplier_email)).toHaveLength(1);
  });

  it('counts court cases by the short name without the legal form and flags the name match', async () => {
    const { d, reg } = await dossier();
    expect(reg.calls.find((c) => c.name === 'count_cases_by_party')!.args.party_name).toBe('КОМПАНІЯ МАСШТАБ БУД');
    expect(d.sections.courts).toMatchObject({ status: 'found', count: 3 });
    expect(d.sections.courts.source.note).toMatch(/не за ЄДРПОУ/);
  });

  it('lists what it could not check and carries a disclaimer', async () => {
    const { d } = await dossier();
    expect(d.not_covered.join(' ')).toMatch(/ЄРПН/);
    expect(d.disclaimer).toMatch(/станом на/);
  });

  it('still returns a dossier when ЄДР does not answer', async () => {
    const { d } = await dossier(registry({ openreyestr_get_by_edrpou: () => { throw new Error('down'); } }));
    expect(d.entity.status).toBe('error');
    expect(d.sections.courts.status).toBe('unavailable');
    expect(d.sections.construction.status).toBe('found');
  });
});

describe('dossier helpers', () => {
  it('toRows understands every sub-tool shape', () => {
    expect(toRows([{ found: false, message: 'нема' }])).toEqual({ rows: [], total: 0, message: 'нема' });
    expect(toRows('текст').rows).toEqual([]);
    expect(toRows({ results: [1, 2], total_count: 9 })).toMatchObject({ rows: [1, 2], total: 9 });
    expect(toRows({ results: [1], total: 4 }).total).toBe(4);
    expect(toRows({ found: false, message: 'x' }).rows).toEqual([]);
    expect(toRows({ a: 1 })).toEqual({ rows: [{ a: 1 }], total: 1 });
  });

  it('trimRow clips long text and drops blobs', () => {
    const r = trimRow({ raw: {}, content_hash: 'x', text: 'а'.repeat(500), n: 1 });
    expect(r).toEqual({ text: `${'а'.repeat(400)}…`, n: 1 });
  });

  it('partyNameFor and registrationDate', () => {
    expect(partyNameFor({ short_name: 'ПП «АЛЬФА»' })).toBe('АЛЬФА');
    // one quoted word plus the owner after the quotes, not every namesake in the country
    expect(partyNameFor({ name: 'КОМУНАЛЬНЕ ПІДПРИЄМСТВО "ВОДОКАНАЛ" ОВРУЦЬКОЇ МІСЬКОЇ РАДИ ЖИТОМИРСЬКОЇ ОБЛАСТІ', short_name: 'КП "ВОДОКАНАЛ"' }))
      .toBe('ВОДОКАНАЛ ОВРУЦЬКОЇ МІСЬКОЇ РАДИ');
    expect(partyNameFor({ name: 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "КОМПАНІЯ МАСШТАБ БУД"' })).toBe('КОМПАНІЯ МАСШТАБ БУД');
    expect(partyNameFor({ name: 'ТОВ ОМЕГА ПЛЮС' })).toBe('ОМЕГА ПЛЮС');
    expect(partyNameFor({ short_name: 'ТОВ "АБ"' })).toBeNull();
    expect(partyNameFor(null)).toBeNull();
    expect(registrationDate({ registration: 'Дата: 01.02.2003' })).toBe('2003-02-01');
    expect(registrationDate({})).toBeNull();
    expect(normEdr('0023227605')).toBe('23227605');
    expect(normEdr('2819204155')).toBe('2819204155');
    expect(normEdr('')).toBeNull();
  });
});

describe('dossier size', () => {
  it('keeps only report fields in ProZorro and Є-Data rows', () => {
    const row = ROW_FIELDS.prozorro_supplier({ tender_number: 'UA-1', title: 'т'.repeat(300), supplier_name: 'X', supplier_address: 'вул', date_created: '2026-09-03T08:17:03.981Z', contract_amount: '5' });
    expect(row).not.toHaveProperty('supplier_name');
    expect(row).not.toHaveProperty('supplier_address');
    expect(row.date_created).toBe('2026-09-03');
    expect(row.title.length).toBe(201);
    const pay = ROW_FIELDS.spending_recipient({ edrpou: '05403286', amount: '1', contractors: [{ address: { city: 'x' } }], doc_type_label: 'Акт' });
    expect(pay).toEqual(expect.objectContaining({ payer_edrpou: '05403286', doc_type: 'Акт' }));
    expect(pay).not.toHaveProperty('contractors');
    const b = ROW_FIELDS.prozorro_buyer({ winners: [{ supplier_edrpou: '1', supplier_name: 'A', contract_amount: '2', date_signed: 'x' }] });
    expect(b.winners).toEqual([{ edrpou: '1', name: 'A', amount: '2' }]);
  });

  it('returns compact JSON and skips filler emails', async () => {
    const res = await new CompanyDossierTool(registry()).executeTool('get_company_dossier', { edrpou: '41633007' });
    expect(res!.content[0].text).not.toMatch(/\n  /);
    expect(isPlaceholderEmail('----------@ukr.net')).toBe(true);
    expect(isPlaceholderEmail('0504441122@ukr.net')).toBe(false);
    expect(isPlaceholderEmail('a@b.ua')).toBe(false);
    expect(isPlaceholderEmail('masshtabbud@gmail.com')).toBe(false);
  });
});
