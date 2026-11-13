/**
 * get_company_dossier (LEXAI-2227): one call, a company dossier by ЄДРПОУ.
 *
 * Orchestrates the existing registry tools through the tool registry (same pattern
 * as get_trademark_dossier) and returns, for every section, where the data came
 * from and how fresh it is. Built for analysts whose output goes to court or to law
 * enforcement, so three rules hold throughout:
 *   1. every section names its source and its "станом на" date;
 *   2. "the source did not answer" (timeout/error) is never shown as "nothing found";
 *   3. risk markers are stated as facts ("one phone shared by 4 suppliers"), never as
 *      a conclusion that the firm is fictitious.
 */
import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';

const SUBTOOL_TIMEOUT_MS = 40_000;
const ROWS_PER_SECTION = 10;
const MAX_TEXT = 400;
const MAX_SHARED_CONTACTS = 3;

export type SectionStatus = 'found' | 'empty' | 'timeout' | 'error' | 'unavailable';

export interface SubCall { status: 'ok' | 'timeout' | 'error' | 'unavailable'; data: any; error?: string }

export interface SectionSource {
  name: string;
  /** Key into openreyestr_get_data_freshness, when the registry lives in openreyestr. */
  freshness?: string;
  /** Coverage caveat that applies whatever the result. */
  note?: string;
}

export interface SectionSpec {
  key: string;
  title: string;
  tool: string;
  args: (edrpou: string) => Record<string, unknown>;
  source: SectionSource;
}

export interface Section {
  title: string;
  status: SectionStatus;
  source: { name: string; tool: string; as_of: string | null; as_of_basis?: string; note?: string };
  count: number;
  /** True when count hit the sub-tool's page size, i.e. there may be more. */
  more_available: boolean;
  items: any[];
  message?: string;
}

const EDR_SOURCE: SectionSource = {
  name: 'ЄДР юридичних осіб, ФОП та громадських формувань (Мін’юст, data.gov.ua)',
  freshness: 'legal_entities',
};

/** Sections that only need the code. Order is the order in the dossier. */
export const SECTION_SPECS: SectionSpec[] = [
  // Санкції
  { key: 'rnbo_sanctions', title: 'Санкції РНБО', tool: 'openreyestr_search_rnbo_sanctions',
    args: (c) => ({ identifier: c }),
    source: { name: 'Державний реєстр санкцій (РНБО)', freshness: 'rnbo_sanctions' } },
  { key: 'international_sanctions', title: 'Міжнародні санкційні списки', tool: 'search_registry',
    args: (c) => ({ registry: 'sanctions', filters: { identifier: c } }),
    source: { name: 'OpenSanctions (РНБО, OFAC, ЄС, ООН та інші)', note: 'Збіг за кодом у полі ідентифікаторів; список без збігу за кодом може містити компанію під іншим ідентифікатором.' } },
  { key: 'war_sanctions', title: '«Війна і санкції» (ГУР)', tool: 'search_registry',
    args: (c) => ({ registry: 'nazk_war_sanctions', filters: { tin: c } }),
    source: { name: 'Портал «Війна і санкції» (ГУР МО)' } },
  // Борги, стягнення, припинення
  { key: 'debtors', title: 'Єдиний реєстр боржників', tool: 'openreyestr_search_debtors',
    args: (c) => ({ edrpou: c }),
    source: { name: 'Єдиний реєстр боржників (Мін’юст)', freshness: 'debtors' } },
  { key: 'enforcement', title: 'Виконавчі провадження (боржник)', tool: 'openreyestr_search_enforcement_proceedings',
    args: (c) => ({ debtor_edrpou: c }),
    source: { name: 'АСВП (Мін’юст)', freshness: 'enforcement_proceedings' } },
  { key: 'tax_debt', title: 'Податковий борг', tool: 'openreyestr_search_tax_debt',
    args: (c) => ({ tin: c }),
    source: { name: 'Платники з податковим боргом (ДПС)', freshness: 'tax_debt' } },
  { key: 'esv_debt', title: 'Борг з ЄСВ', tool: 'openreyestr_search_esv_debt',
    args: (c) => ({ tin: c }),
    source: { name: 'Боржники з ЄСВ (ДПС)', freshness: 'esv_debt' } },
  { key: 'bankruptcy_cases', title: 'Справи про банкрутство', tool: 'openreyestr_search_bankruptcy_cases',
    args: (c) => ({ debtor_edrpou: c }),
    source: { name: 'Реєстр підприємств у справах про банкрутство', freshness: 'bankruptcy_cases' } },
  { key: 'bankruptcy_announcements', title: 'Оголошення про банкрутство', tool: 'search_registry',
    args: (c) => ({ registry: 'bankruptcy_announcements', filters: { firm_edrpou: c } }),
    source: { name: 'Оголошення про порушення справ про банкрутство (судова влада)' } },
  { key: 'termination', title: 'Розпочате припинення', tool: 'openreyestr_search_termination_started',
    args: (c) => ({ query: c }),
    source: { name: 'ЄДР: відомості про припинення', freshness: 'termination_started' } },
  // Податковий статус
  { key: 'single_tax', title: 'Платник єдиного податку', tool: 'openreyestr_search_single_tax_payers',
    args: (c) => ({ tin: c }),
    source: { name: 'Реєстр платників єдиного податку (ДПС)', freshness: 'single_tax_payers' } },
  { key: 'large_taxpayer', title: 'Великий платник податків', tool: 'search_registry',
    args: (c) => ({ registry: 'large_taxpayers', filters: { edrpou: c } }),
    source: { name: 'Перелік великих платників податків (ДПС)' } },
  { key: 'financial_statements', title: 'Фінансова звітність', tool: 'search_registry',
    args: (c) => ({ registry: 'financial_statements', filters: { tin: c } }),
    source: { name: 'Фінансова звітність юридичних осіб (ДПС/ДССУ)' } },
  // Публічні кошти та діяльність
  { key: 'prozorro_supplier', title: 'ProZorro: договори як постачальник', tool: 'openreyestr_search_prozorro',
    args: (c) => ({ supplier_edrpou: c, limit: 50 }),
    source: { name: 'ProZorro (public-api.prozorro.gov.ua)', freshness: 'prozorro_contracts' } },
  { key: 'prozorro_buyer', title: 'ProZorro: закупівлі як замовник', tool: 'openreyestr_search_prozorro',
    args: (c) => ({ buyer_edrpou: c, limit: 20 }),
    source: { name: 'ProZorro (public-api.prozorro.gov.ua)', freshness: 'prozorro_tenders' } },
  { key: 'spending_recipient', title: 'Є-Data: платежі на користь компанії', tool: 'search_public_spending',
    args: (c) => ({ contractor_edrpou: c, limit: 20 }),
    source: { name: 'Є-Data / spending.gov.ua (Мінфін)' } },
  { key: 'construction', title: 'Будівельна діяльність (ЄДЕССБ)', tool: 'search_registry',
    args: (c) => ({ registry: 'construction_documents', filters: { edrpou: c } }),
    source: { name: 'Реєстр будівельної діяльності ЄДЕССБ (Мінрозвитку, CC BY 4.0, «Портал ЄДЕССБ»)',
      note: 'Відкриті дані є лише за 2021, 01.01–22.02.2022 і 2026 рік; 23.02.2022–31.12.2025 не опубліковано. Генпідрядник у 2026 році заповнений менш ніж у 10% документів.' } },
  { key: 'amcu_bid_rigging', title: 'АМКУ: спотворення торгів', tool: 'search_registry',
    args: (c) => ({ registry: 'amcu_bid_rigging', filters: { edrpou: c } }),
    source: { name: 'Рішення АМКУ щодо антиконкурентних узгоджених дій' } },
  { key: 'securities_issuer', title: 'Цінні папери: емітент', tool: 'search_registry',
    args: (c) => ({ registry: 'securities_owners', filters: { issuer_edrpou: c } }),
    source: { name: 'Власники цінних паперів (НКЦПФР)' } },
  { key: 'securities_owner', title: 'Цінні папери: власник', tool: 'search_registry',
    args: (c) => ({ registry: 'securities_owners', filters: { owner_edrpou: c } }),
    source: { name: 'Власники цінних паперів (НКЦПФР)' } },
  { key: 'trademarks', title: 'Торговельні марки', tool: 'search_registry',
    args: (c) => ({ registry: 'trademarks', filters: { holder_edrpou: c } }),
    source: { name: 'Реєстр торговельних марок (НОІВ/УКРНОІВІ)' } },
];

/** What a reader must not infer from silence: checks the dossier cannot run. */
export const NOT_COVERED: string[] = [
  'Податкові накладні (ЄРПН) і банківські виписки: не є відкритими даними.',
  'Ліцензії (пальне, алкоголь, тютюн, перевезення, медицина): реєстри ще не підключені.',
  'PEP (публічні особи) та зв’язки з ними: реєстр не підключений.',
  'Масова адреса реєстрації, масовий директор або засновник: у вивантаженні ЄДР немає адреси, а засновники й підписанти є вільним текстом, тому підрахунок поки неможливий.',
  'Судові рішення шукаються за назвою сторони, а не за кодом ЄДРПОУ: можливі збіги з однойменними компаніями і пропуски через інше написання назви.',
  'Арештоване майно АРМА: власник у відкритих даних не публікується.',
  'Реєстр платників ПДВ: пошук лише за назвою або індивідуальним податковим номером, не за ЄДРПОУ.',
];

/** Rows out of whatever shape a sub-tool returns; found:false markers count as empty. */
export function toRows(data: any): { rows: any[]; total: number | null; message?: string } {
  if (data == null) return { rows: [], total: 0 };
  if (typeof data === 'string') return { rows: [], total: 0, message: data.slice(0, MAX_TEXT) };
  if (Array.isArray(data)) {
    const notFound = data.length > 0 && data.every((r) => r && r.found === false);
    if (notFound) return { rows: [], total: 0, message: data[0].message };
    return { rows: data, total: null };
  }
  if (Array.isArray(data.results)) {
    const total = typeof data.total_count === 'number' ? data.total_count : typeof data.total === 'number' ? data.total : null;
    return { rows: data.results, total, message: data.message };
  }
  if (data.found === false) return { rows: [], total: 0, message: data.message };
  return { rows: [data], total: 1 };
}

/** Shallow copy with long strings clipped and heavy blobs dropped. */
export function trimRow(row: any): any {
  if (!row || typeof row !== 'object') return row;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'raw' || k === 'raw_data' || k === 'content_hash' || k === '_total_count') continue;
    out[k] = typeof v === 'string' && v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}…` : v;
  }
  return out;
}

/** Company name for a court-party search: short name, legal form and quotes removed. */
export function partyNameFor(entity: any): string | null {
  const raw = String(entity?.short_name || entity?.name || '').trim();
  if (!raw) return null;
  const quoted = raw.match(/[«"“]([^»"”]+)[»"”]/);
  const core = (quoted ? quoted[1] : raw)
    .replace(/^(ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ|ПРИВАТНЕ ПІДПРИЄМСТВО|ТОВ|ПП|ПРАТ|ПАТ|АТ|ДП|КП)\s+/i, '')
    .trim();
  return core.length >= 3 ? core : null;
}

/** First dd.mm.yyyy in the ЄДР "registration" text, as ISO. */
export function registrationDate(entity: any): string | null {
  const m = String(entity?.registration || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export class CompanyDossierTool extends BaseToolHandler {
  constructor(private toolRegistry?: { executeTool(name: string, args: any): Promise<ToolResult | null> }) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [{
      name: 'get_company_dossier',
      annotations: { title: 'Досьє компанії за ЄДРПОУ', readOnlyHint: true },
      description: `Досьє юридичної особи за кодом ЄДРПОУ в одному виклику, з джерелом і датою актуальності («станом на») для кожного розділу.

Розділи: ЄДР (стан, реєстрація, керівник, засновники, бенефіціари, адреса й КВЕД з фінзвітності); санкції (РНБО, міжнародні списки, «Війна і санкції» ГУР); боржники, виконавчі провадження, податковий борг, борг з ЄСВ, банкрутство, припинення; єдиний податок, великий платник, фінзвітність; ProZorro як постачальник і як замовник, платежі Є-Data, будівельна діяльність ЄДЕССБ, АМКУ (змова на торгах), цінні папери, торговельні марки; судові справи за назвою.

Окремо: facts (стислі факти з посиланням на розділ), markers (ознаки ризику як факти, наприклад спільний телефон чи email з іншими постачальниками ProZorro, без висновку про фіктивність) і not_covered (що не перевірялося і чому). Розділ зі статусом timeout або error означає, що джерело не відповіло, а не що записів немає.`,
      inputSchema: {
        type: 'object',
        properties: {
          edrpou: { type: 'string', description: 'Код ЄДРПОУ юридичної особи (8 цифр)' },
        },
        required: ['edrpou'],
      },
    }];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    if (name !== 'get_company_dossier') return null;
    const edrpou = String(args?.edrpou ?? '').replace(/\D/g, '');
    if (!/^\d{8}$/.test(edrpou)) {
      return this.wrapResponse({
        error: edrpou.length === 10
          ? 'Досьє ФОП (10-значний РНОКПП) поки не підтримується: вкажіть 8-значний код ЄДРПОУ юридичної особи.'
          : 'Вкажіть 8-значний код ЄДРПОУ юридичної особи.',
      });
    }
    return this.wrapResponse(await this.buildDossier(edrpou));
  }

  async buildDossier(edrpou: string): Promise<any> {
    const generatedAt = new Date().toISOString();
    // Everything starts at once; a call that needs an earlier result is chained on
    // that result only, so the worst case is two soft deadlines, not one per phase.
    const edrP = this.call('openreyestr_get_by_edrpou', { edrpou });
    const entityP = edrP.then((edr) => (edr.status === 'ok' ? toRows(edr.data).rows[0] ?? null : null));
    const detailsP = entityP.then((entity) => (entity?.record
      ? this.call('openreyestr_get_entity_details', { record: String(entity.record), entityType: entity.entity_type === 'FSU' ? 'FSU' : 'UO' })
      : null));
    const courtsP = entityP.then((entity): Promise<{ party: string | null; c: SubCall }> | { party: string | null; c: SubCall } => {
      const party = partyNameFor(entity);
      return party
        ? this.call('count_cases_by_party', { party_name: party, party_type: 'any' }).then((c) => ({ party: party as string | null, c }))
        : { party: null, c: { status: 'unavailable', data: null } as SubCall };
    });
    const sectionPs = SECTION_SPECS.map((s) => this.call(s.tool, s.args(edrpou)));
    const supplierIdx = SECTION_SPECS.findIndex((s) => s.key === 'prozorro_supplier');
    const markersP = sectionPs[supplierIdx].then((c) => this.sharedContactMarkers(edrpou, c));

    const [edr, entity, details, courts, freshnessCall, markers, ...sectionCalls] = await Promise.all([
      edrP, entityP, detailsP, courtsP, this.call('openreyestr_get_data_freshness', {}), markersP, ...sectionPs,
    ]);
    const freshness: Record<string, any> = freshnessCall.status === 'ok' && freshnessCall.data && typeof freshnessCall.data === 'object'
      ? freshnessCall.data : {};

    const sections: Record<string, Section> = {};
    SECTION_SPECS.forEach((spec, i) => {
      sections[spec.key] = this.section(spec.title, spec.tool, spec.source, sectionCalls[i], freshness);
    });
    sections.courts = this.courtsSection(courts.party, courts.c);

    const entityBlock = this.entityBlock(edrpou, edr, entity, details, freshness);
    return {
      edrpou,
      generated_at: generatedAt,
      entity: entityBlock,
      facts: this.facts(entityBlock, sections),
      markers,
      sections,
      not_covered: NOT_COVERED,
      disclaimer: 'Довідку сформовано автоматично з відкритих державних реєстрів станом на дати, зазначені в кожному розділі. ' +
        'Відсутність запису означає лише відсутність у відповідному джерелі на цю дату. Ознаки ризику наведено як факти без правової оцінки.',
    };
  }

  private entityBlock(edrpou: string, edr: SubCall, entity: any, details: SubCall | null, freshness: Record<string, any>): any {
    const fr = freshness[EDR_SOURCE.freshness!] ?? {};
    const source = { name: EDR_SOURCE.name, tool: 'openreyestr_get_by_edrpou', as_of: fr.as_of ?? null, as_of_basis: fr.basis };
    if (edr.status !== 'ok') return { status: edr.status, source, message: 'ЄДР не відповів; дані про компанію не отримано.' };
    if (!entity) return { status: 'empty', source, message: `Код ${edrpou} не знайдено в ЄДР юридичних осіб і громадських формувань.` };

    const d = details?.status === 'ok' && details.data && typeof details.data === 'object' ? details.data : {};
    const text = (rows: any[], field: string) => (Array.isArray(rows) ? rows.map((r) => r?.[field]).filter(Boolean).slice(0, 20) : []);
    const addr = d.addressAndActivity;
    return {
      status: 'found',
      source,
      edrpou,
      record: entity.record ?? null,
      name: entity.name ?? null,
      short_name: entity.short_name ?? null,
      legal_form: entity.opf ?? null,
      state: entity.stan ?? null,
      registration: entity.registration ?? null,
      registration_date: registrationDate(entity),
      authorized_capital: entity.authorized_capital ?? null,
      management: entity.superior_management ?? null,
      terminated_info: entity.terminated_info ?? null,
      founders: text(d.founders, 'founder_info'),
      beneficiaries: text(d.beneficiaries, 'beneficiary_info'),
      signers: text(d.signers, 'signer_info'),
      address_and_activity: addr
        ? { ...addr, source: { name: 'Фінансова звітність (ДССУ)', as_of: addr.reportYear ? `звіт за ${addr.reportYear} рік` : (freshness.dssu_financial_reports?.as_of ?? null) } }
        : null,
      details_status: details ? details.status : 'unavailable',
    };
  }

  private section(title: string, tool: string, src: SectionSource, call: SubCall, freshness: Record<string, any>): Section {
    const fr = src.freshness ? freshness[src.freshness] ?? {} : {};
    const note = [src.note, fr.note].filter(Boolean).join(' ') || undefined;
    const source = { name: src.name, tool, as_of: fr.as_of ?? null, ...(fr.basis ? { as_of_basis: fr.basis } : {}),
      ...(src.freshness ? {} : { as_of_basis: 'дати наведено в записах' }), ...(note ? { note } : {}) };
    if (call.status !== 'ok') {
      return { title, status: call.status, source, count: 0, more_available: false, items: [],
        message: call.status === 'timeout' ? 'Джерело не відповіло вчасно: результат невідомий.' : 'Помилка запиту до джерела: результат невідомий.' };
    }
    const { rows, total, message } = toRows(call.data);
    const count = total ?? rows.length;
    return {
      title, status: rows.length ? 'found' : 'empty', source, count,
      more_available: total == null && rows.length >= 20,
      items: rows.slice(0, ROWS_PER_SECTION).map(trimRow),
      ...(rows.length ? {} : { message: message || 'Записів не знайдено.' }),
    };
  }

  private courtsSection(party: string | null, call: SubCall): Section {
    const source = { name: 'Єдиний державний реєстр судових рішень (ЄДРСР)', tool: 'count_cases_by_party', as_of: null,
      note: `Пошук за назвою сторони «${party ?? '—'}», а не за ЄДРПОУ: можливі однойменні компанії.` };
    if (!party) return { title: 'Судові справи', status: 'unavailable', source, count: 0, more_available: false, items: [], message: 'Назву компанії не отримано з ЄДР.' };
    if (call.status !== 'ok') return { title: 'Судові справи', status: call.status, source, count: 0, more_available: false, items: [], message: 'Пошук у ЄДРСР не відповів: результат невідомий.' };
    const d = call.data && typeof call.data === 'object' ? call.data : {};
    const count = Number(d.total_cases ?? d.count ?? d.total ?? 0) || 0;
    return { title: 'Судові справи', status: count ? 'found' : 'empty', source, count, more_available: false,
      items: [trimRow(d)], ...(count ? {} : { message: 'Справ за цією назвою не знайдено.' }) };
  }

  /**
   * The same phone or email on a different supplier is a link worth checking.
   * Uses the contacts on this company's ProZorro contracts; placeholders are already
   * dropped at import.
   */
  async sharedContactMarkers(edrpou: string, supplier: SubCall): Promise<any[]> {
    if (supplier.status !== 'ok') return [];
    const phones = new Set<string>();
    const emails = new Set<string>();
    for (const r of toRows(supplier.data).rows) {
      if (r.supplier_phone) phones.add(String(r.supplier_phone));
      if (r.supplier_email) emails.add(String(r.supplier_email));
    }
    const probes: Array<{ kind: 'phone' | 'email'; value: string }> = [
      ...[...phones].slice(0, MAX_SHARED_CONTACTS).map((value) => ({ kind: 'phone' as const, value })),
      ...[...emails].slice(0, MAX_SHARED_CONTACTS).map((value) => ({ kind: 'email' as const, value })),
    ];
    const results = await Promise.all(probes.map((p) =>
      this.call('openreyestr_search_prozorro', { [p.kind === 'phone' ? 'supplier_phone' : 'supplier_email']: p.value, limit: 100 })));
    const markers: any[] = [];
    probes.forEach((p, i) => {
      if (results[i].status !== 'ok') return;
      const others = new Map<string, string>();
      for (const r of toRows(results[i].data).rows) {
        if (r.supplier_edrpou && r.supplier_edrpou !== edrpou) others.set(r.supplier_edrpou, r.supplier_name || '');
      }
      if (others.size === 0) return;
      markers.push({
        marker: p.kind === 'phone' ? 'shared_phone' : 'shared_email',
        fact: `${p.kind === 'phone' ? 'Телефон' : 'Email'} ${p.value} у договорах ProZorro вказаний також для ${others.size} інш${others.size === 1 ? 'ого постачальника' : 'их постачальників'}.`,
        other_suppliers: [...others].slice(0, 20).map(([code, name]) => ({ edrpou: code, name })),
        source: { name: 'ProZorro: контактні дані постачальника в договорах', tool: 'openreyestr_search_prozorro' },
      });
    });
    return markers;
  }

  facts(entity: any, sections: Record<string, Section>): Array<{ fact: string; section: string }> {
    const out: Array<{ fact: string; section: string }> = [];
    if (entity.status === 'found') {
      out.push({ section: 'entity', fact: `${entity.name || entity.short_name}, стан: ${entity.state ?? 'невідомо'}${entity.registration_date ? `, зареєстровано ${entity.registration_date}` : ''}.` });
    }
    for (const [key, s] of Object.entries(sections)) {
      if (s.status === 'found') {
        const n = s.more_available ? `${s.count}+` : String(s.count);
        out.push({ section: key, fact: `${s.title}: ${key === 'courts' ? `${n} справ за назвою` : `знайдено записів: ${n}`}.` });
      } else if (s.status === 'timeout' || s.status === 'error') {
        out.push({ section: key, fact: `${s.title}: джерело не відповіло, перевірку не виконано.` });
      }
    }
    const won = sections.prozorro_supplier;
    if (won?.status === 'found') {
      const sum = won.items.reduce((a, r) => a + (Number(r.contract_amount) || 0), 0);
      if (sum > 0) out.push({ section: 'prozorro_supplier', fact: `Сума ${won.items.length} останніх договорів ProZorro як постачальника: ${Math.round(sum).toLocaleString('uk-UA')} грн.` });
    }
    return out;
  }

  /** Best-effort sub-tool call with a soft deadline; says why there is no data. */
  async call(name: string, args: any): Promise<SubCall> {
    if (!this.toolRegistry) return { status: 'unavailable', data: null };
    let timer: NodeJS.Timeout | undefined;
    const TIMEOUT = Symbol('timeout');
    try {
      const res = await Promise.race([
        this.toolRegistry.executeTool(name, args),
        new Promise<typeof TIMEOUT>((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), SUBTOOL_TIMEOUT_MS); }),
      ]);
      if (res === TIMEOUT) {
        logger.warn(`get_company_dossier: sub-tool ${name} exceeded ${SUBTOOL_TIMEOUT_MS} ms`);
        return { status: 'timeout', data: null };
      }
      if (!res) return { status: 'unavailable', data: null };
      const txt = res.content?.[0]?.text;
      if (res.isError) return { status: 'error', data: null, error: typeof txt === 'string' ? txt.slice(0, 300) : undefined };
      if (typeof txt !== 'string') return { status: 'error', data: null };
      try { return { status: 'ok', data: JSON.parse(txt) }; } catch { return { status: 'ok', data: txt }; }
    } catch (e: any) {
      logger.warn(`get_company_dossier: sub-tool ${name} failed`, { error: e.message });
      return { status: 'error', data: null, error: e.message };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
