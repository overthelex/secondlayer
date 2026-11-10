/**
 * PlRegistryTools: the Polish open registers held in pg-lawrider.
 *
 *   KRS company register      pl_krs_entities (migration 249)
 *   Sejm                      pl_sejm_objects (250)
 *   e-Zamówienia BZP          pl_bzp_notices (252, full-text index 256)
 *   SLPS case assignment      pl_slps_draws, pl_slps_department_judges (253)
 *   Small official registers  pl_opendata_rows (251)
 *
 * Text search uses the 'simple' configuration of the existing GIN indexes. Postgres ships no
 * Polish stemmer, so a query matches the exact word forms it contains, and the tool
 * descriptions say so. Every full-text expression below must stay identical to its index
 * definition, or the query silently becomes a sequential scan.
 *
 * pl_lawyers is deliberately not exposed: it is the attorney CRM's contact list.
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';
import {
  htmlToText, identifierDigits, INFLECTED_SEARCH_NOTE, isoDate, isTimeout, nameVariants, pageOf, pageResponse, runQuery, runSearchQuery, sliceText, toTsQuery, wordForms,
} from './pl-tool-utils.js';

const MAX_JSON_CHARS = 60_000;
const NOTICE_TEXT_CHARS = 30_000;

const KRS_SECTIONS = ['dzial1', 'dzial2', 'dzial3', 'dzial4', 'dzial5', 'dzial6'];
const COMPANY_STATUSES = ['current', 'struck_off', 'all'];
const NOTICE_TYPES = [
  'ContractNotice', 'TenderResultNotice', 'ContractPerformingNotice', 'NoticeUpdateNotice',
  'AgreementIntentionNotice', 'SmallContractNotice', 'AgreementUpdateNotice', 'CompetitionNotice',
  'CompetitionResultNotice', 'ConcessionNotice', 'ConcessionAgreementNotice',
];
const SEJM_KINDS = ['mp', 'committee', 'print', 'proceeding', 'bill', 'process', 'interpellation',
  'written_question', 'voting'];
const REGISTERS = ['teryt_terc', 'teryt_simc', 'teryt_ulic', 'komornicy', 'rzecznicy_patentowi',
  'kprm_wykaz', 'mswia_sankcje', 'sady_lista', 'sady_teleadres', 'sady_struktura', 'sady_wlasciwosc'];

const COMPANY_COLS = `krs, rejestr, status, name, legal_form, nip, regon, voivodeship, city,
  registered_on, last_entry_on, struck_off_on, is_opp`;
const NOTICE_COLS = `object_id, notice_type, notice_number, bzp_number, tender_id, publication_date,
  order_type, order_object, cpv_code, below_eu_threshold, submitting_offers_date, procedure_result,
  organization_name, organization_nip, organization_city, organization_province, contractors`;
const BZP_FTS = `to_tsvector('simple'::regconfig, coalesce(organization_name, '') || ' ' || coalesce(order_object, ''))`;

const WORD_FORMS_NOTE = 'Пошук за точними формами слів (польського стемера немає): усі слова запиту мають бути в тексті саме в цій формі.';
const PAGING = {
  limit: { type: 'number', default: 20, maximum: 50, description: 'Макс. результатів' },
  offset: { type: 'number', default: 0, maximum: 1000, description: 'Зсув для пагінації' },
};

export class PlRegistryTools extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'pl_search_companies',
        annotations: { title: 'Пошук компаній Польщі (KRS)', readOnlyHint: true },
        description: `Пошук суб'єктів у польському Національному судовому реєстрі KRS (1,19 млн записів) за назвою, номером KRS, NIP або REGON.

Запит із самих цифр розпізнається автоматично: 9 або 14 цифр = REGON, 10 цифр = KRS або NIP, менше = номер KRS. Інакше пошук за назвою. ${WORD_FORMS_NOTE}
status: current (чинні), struck_off (виключені), all (типово). Далі: pl_get_company для витягу.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Назва, номер KRS, NIP або REGON' },
            status: { type: 'string', enum: COMPANY_STATUSES, default: 'all', description: 'Стан у реєстрі' },
            voivodeship: { type: 'string', description: 'Воєводство, напр. MAZOWIECKIE' },
            ...PAGING,
          },
          required: ['query'],
        },
      },
      {
        name: 'pl_get_company',
        annotations: { title: 'Витяг KRS компанії Польщі', readOnlyHint: true },
        description: `Витяг із реєстру KRS за номером KRS або NIP: основні поля і розділи витягу.

Типово повертає dzial1 (дані, адреса, капітал, статут) і dzial2 (представництво, наглядовий орган). Інші розділи: dzial3 (діяльність, звіти), dzial4 (борги), dzial5 (куратор), dzial6 (ліквідація, банкрутство, реструктуризація).
УВАГА: відкрите API KRS маскує імена фізичних осіб і PESEL (напр. "M*******"), тому склад органів видно лише за функціями.`,
        inputSchema: {
          type: 'object',
          properties: {
            krs: { type: 'string', description: 'Номер KRS' },
            nip: { type: 'string', description: 'NIP, якщо номер KRS невідомий' },
            sections: { type: 'array', items: { type: 'string', enum: KRS_SECTIONS }, description: 'Розділи витягу; типово dzial1 і dzial2' },
          },
        },
      },
      {
        name: 'pl_search_procurement',
        annotations: { title: 'Публічні закупівлі Польщі (BZP)', readOnlyHint: true },
        description: `Пошук оголошень польського Бюлетеня публічних закупівель BZP (2,9 млн, з 2021 року), найновіші першими.

Потрібен хоча б один із параметрів: query (назва замовника або предмет закупівлі), organization_nip (замовник), contractor_nip (виконавець), tender_id. ${INFLECTED_SEARCH_NOTE}
Інші параметри лише звужують результат. Далі: pl_get_procurement_notice для повного тексту.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Слова з назви замовника або предмета закупівлі' },
            organization_nip: { type: 'string', description: 'NIP замовника' },
            contractor_nip: { type: 'string', description: 'NIP виконавця' },
            tender_id: { type: 'string', description: 'Ідентифікатор процедури' },
            notice_type: { type: 'string', enum: NOTICE_TYPES, description: 'Тип оголошення' },
            cpv: { type: 'string', description: 'Початок коду CPV, напр. 45 або 45233' },
            province: { type: 'string', description: 'Код воєводства NUTS, напр. PL14' },
            date_from: { type: 'string', description: 'Опубліковано від (YYYY-MM-DD)' },
            date_to: { type: 'string', description: 'Опубліковано до (YYYY-MM-DD, включно)' },
            ...PAGING,
          },
        },
      },
      {
        name: 'pl_get_procurement_notice',
        annotations: { title: 'Оголошення BZP', readOnlyHint: true },
        description: `Повне оголошення BZP за object_id із pl_search_procurement: реквізити, виконавці і текст. Текст віддається вікном до 30 000 символів; наступне вікно задає text_offset.`,
        inputSchema: {
          type: 'object',
          properties: {
            object_id: { type: 'string', description: 'object_id оголошення' },
            text_offset: { type: 'number', default: 0, description: 'Позиція початку тексту' },
          },
          required: ['object_id'],
        },
      },
      {
        name: 'pl_search_case_assignments',
        annotations: { title: 'Жеребкування справ у судах Польщі (SLPS)', readOnlyHint: true },
        description: `Пошук у звітах Системи випадкового розподілу справ SLPS: який суддя отримав справу, з яким пулом кандидатів. Дати жеребкувань від 2018 року.

Потрібен case_signature (точна сигнатура, напр. "III AUa 332/24") або judge (ім'я та прізвище). Найновіші першими.`,
        inputSchema: {
          type: 'object',
          properties: {
            case_signature: { type: 'string', description: 'Сигнатура справи' },
            judge: { type: 'string', description: "Ім'я та прізвище головуючого судді" },
            court: { type: 'string', description: 'Частина назви суду, напр. "SA we Wrocławiu"' },
            date_from: { type: 'string', description: 'Від (YYYY-MM-DD)' },
            date_to: { type: 'string', description: 'До (YYYY-MM-DD, включно)' },
            ...PAGING,
          },
        },
      },
      {
        name: 'pl_get_judge_workload',
        annotations: { title: 'Навантаження судді Польщі (SLPS)', readOnlyHint: true },
        description: `Останнє відоме навантаження судді в кожному відділі за звітами SLPS: день звіту, участь у пулі, показник навантаження, делегування за ст. 77 §9. Дата показника залежить від того, коли суддя востаннє був кандидатом у жеребкуванні, тож дивіться поле day.`,
        inputSchema: {
          type: 'object',
          properties: {
            judge: { type: 'string', description: "Ім'я та прізвище судді" },
            court: { type: 'string', description: 'Частина назви суду' },
          },
          required: ['judge'],
        },
      },
      {
        name: 'pl_search_sejm',
        annotations: { title: 'Пошук у даних Сейму Польщі', readOnlyHint: true },
        description: `Пошук за назвою в об'єктах Сейму: bill (законопроєкти), process (законодавчі процеси), print (друки), voting (голосування), interpellation, written_question, proceeding (засідання), committee, mp. Каденції 9 і 10. ${INFLECTED_SEARCH_NOTE} Далі: pl_get_sejm_object.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Слова з назви' },
            kind: { type: 'string', enum: SEJM_KINDS, description: "Вид об'єкта" },
            term: { type: 'number', description: 'Каденція, напр. 10' },
            ...PAGING,
          },
          required: ['query'],
        },
      },
      {
        name: 'pl_get_sejm_object',
        annotations: { title: "Об'єкт Сейму Польщі", readOnlyHint: true },
        description: `Повні дані об'єкта Сейму за kind, term і key із pl_search_sejm. Для голосувань поіменні голоси додаються лише з include_votes=true.`,
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: SEJM_KINDS, description: "Вид об'єкта" },
            term: { type: 'number', description: 'Каденція' },
            key: { type: 'string', description: 'Ключ об’єкта' },
            include_votes: { type: 'boolean', default: false, description: 'Поіменні голоси депутатів' },
          },
          required: ['kind', 'term', 'key'],
        },
      },
      {
        name: 'pl_search_register',
        annotations: { title: 'Офіційні довідники Польщі', readOnlyHint: true },
        description: `Пошук в офіційних довідниках Польщі:
komornicy (судові виконавці), rzecznicy_patentowi (патентні повірені), mswia_sankcje (санкційний список МВС), kprm_wykaz (перелік законодавчих робіт уряду), sady_lista, sady_teleadres, sady_struktura, sady_wlasciwosc (суди, контакти, структура, територіальна юрисдикція), teryt_terc, teryt_simc, teryt_ulic (адміністративний поділ, населені пункти, вулиці).

Без query повертає записи довідника по порядку. ${WORD_FORMS_NOTE}`,
        inputSchema: {
          type: 'object',
          properties: {
            register: { type: 'string', enum: REGISTERS, description: 'Довідник' },
            query: { type: 'string', description: 'Слова для пошуку' },
            ...PAGING,
          },
          required: ['register'],
        },
      },
    ];
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    if (!this.handles(name)) return null;
    try {
      switch (name) {
        case 'pl_search_companies': return await this.searchCompanies(args);
        case 'pl_get_company': return await this.getCompany(args);
        case 'pl_search_procurement': return await this.searchProcurement(args);
        case 'pl_get_procurement_notice': return await this.getNotice(args);
        case 'pl_search_case_assignments': return await this.searchAssignments(args);
        case 'pl_get_judge_workload': return await this.judgeWorkload(args);
        case 'pl_search_sejm': return await this.searchSejm(args);
        case 'pl_get_sejm_object': return await this.getSejmObject(args);
        case 'pl_search_register': return await this.searchRegister(args);
        default: return null;
      }
    } catch (err) {
      logger.error('[PlRegistryTools] query failed', { tool: name, error: (err as Error).message });
      return this.wrapError(isTimeout(err)
        ? 'Запит виконувався надто довго. Уточніть його або додайте фільтри.'
        : 'Не вдалося виконати запит до реєстру.');
    }
  }

  private async searchCompanies(args: Record<string, unknown>): Promise<ToolResult> {
    const query = String(args.query ?? '').trim();
    if (!query) return this.wrapError('Вкажіть query: назву, номер KRS, NIP або REGON.');
    const status = String(args.status ?? 'all');
    if (!COMPANY_STATUSES.includes(status)) return this.wrapError(`status має бути одним з: ${COMPANY_STATUSES.join(', ')}.`);
    const page = pageOf(args);

    const params: unknown[] = [];
    const where: string[] = [];
    const digits = identifierDigits(query);
    let queryKind = 'name';
    if (digits && digits.length <= 14) {
      params.push(digits.length < 10 ? digits.padStart(10, '0') : digits);
      if (digits.length === 9 || digits.length === 14) {
        where.push('regon = $1');
        queryKind = 'regon';
      } else if (digits.length === 10) {
        where.push('(krs = $1 OR nip = $1)');
        queryKind = 'krs_or_nip';
      } else if (digits.length < 9) {
        where.push('krs = $1');
        queryKind = 'krs';
      } else {
        return this.wrapError('Ідентифікатор має містити до 10 цифр (KRS, NIP), 9 або 14 цифр (REGON).');
      }
    } else {
      params.push(query);
      where.push(`to_tsvector('simple'::regconfig, coalesce(name, '')) @@ plainto_tsquery('simple'::regconfig, $1)`);
    }
    if (status !== 'all') {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    if (args.voivodeship) {
      params.push(String(args.voivodeship).trim().toLocaleUpperCase('pl'));
      where.push(`voivodeship = $${params.length}`);
    }
    const rows = await runQuery(this.db,
      `SELECT ${COMPANY_COLS} FROM pl_krs_entities WHERE ${where.join(' AND ')}
       ORDER BY (status = 'current') DESC, name, krs LIMIT ${page.limit + 1} OFFSET ${page.offset}`, params);
    return this.wrapResponse(pageResponse(rows, page, { query_kind: queryKind }));
  }

  private async getCompany(args: Record<string, unknown>): Promise<ToolResult> {
    const krs = args.krs ? identifierDigits(args.krs) : null;
    const nip = args.nip ? identifierDigits(args.nip) : null;
    if (!krs && !nip) return this.wrapError('Вкажіть krs або nip цифрами.');
    const sections = Array.isArray(args.sections) && args.sections.length ? args.sections.map(String) : ['dzial1', 'dzial2'];
    const bad = sections.filter((s) => !KRS_SECTIONS.includes(s));
    if (bad.length) return this.wrapError(`Невідомі розділи: ${bad.join(', ')}. Доступні: ${KRS_SECTIONS.join(', ')}.`);

    const rows = await runQuery(this.db,
      `SELECT ${COMPANY_COLS}, odpis_kind, odpis, source_url, fetched_at FROM pl_krs_entities
       WHERE ${krs ? 'krs = $1' : 'nip = $1'} LIMIT 2`,
      [krs ? krs.padStart(10, '0') : nip]);
    if (!rows.length) return this.wrapResponse({ error: 'not_found', krs: krs ?? undefined, nip: nip ?? undefined });

    const { odpis, ...company } = rows[0];
    const data = odpis?.dane ?? {};
    const out: Record<string, unknown> = {};
    const skipped: string[] = [];
    let used = 0;
    for (const s of sections) {
      const size = JSON.stringify(data[s] ?? null).length;
      if (used + size > MAX_JSON_CHARS) {
        skipped.push(s);
        continue;
      }
      used += size;
      out[s] = data[s] ?? null;
    }
    return this.wrapResponse({
      company,
      odpis_header: odpis?.naglowekA ?? null,
      sections: out,
      ...(skipped.length ? { sections_too_large: skipped, note_large: 'Запитайте ці розділи окремо.' } : {}),
      ...(rows.length > 1 ? { other_entities_with_this_nip: true } : {}),
      personal_data_note: 'Імена фізичних осіб і PESEL замасковані джерелом.',
    });
  }

  private async searchProcurement(args: Record<string, unknown>): Promise<ToolResult> {
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (sql: (n: number) => string, value: unknown) => {
      params.push(value);
      where.push(sql(params.length));
    };

    const query = String(args.query ?? '').trim();
    if (query) add((n) => `${BZP_FTS} @@ $${n}::tsquery`, toTsQuery(await wordForms(this.db, query)));
    if (args.organization_nip) {
      const nip = identifierDigits(args.organization_nip);
      if (!nip) return this.wrapError('organization_nip має складатися з цифр.');
      add((n) => `organization_nip = $${n}`, nip);
    }
    if (args.contractor_nip) {
      const nip = identifierDigits(args.contractor_nip);
      if (!nip) return this.wrapError('contractor_nip має складатися з цифр.');
      add((n) => `contractors @> $${n}::jsonb`, JSON.stringify([{ contractorNationalId: nip }]));
    }
    if (args.tender_id) add((n) => `tender_id = $${n}`, String(args.tender_id).trim());
    if (!where.length) return this.wrapError('Вкажіть query, organization_nip, contractor_nip або tender_id.');

    if (args.notice_type) {
      if (!NOTICE_TYPES.includes(String(args.notice_type))) return this.wrapError(`notice_type має бути одним з: ${NOTICE_TYPES.join(', ')}.`);
      add((n) => `notice_type = $${n}`, String(args.notice_type));
    }
    if (args.cpv) add((n) => `cpv_code LIKE $${n}`, `${String(args.cpv).replace(/[^\d-]/g, '')}%`);
    if (args.province) add((n) => `organization_province = $${n}`, String(args.province).trim().toUpperCase());
    const from = this.dateArg(args.date_from);
    const to = this.dateArg(args.date_to);
    if (from === false || to === false) return this.wrapError('Дати мають бути у форматі YYYY-MM-DD.');
    if (from) add((n) => `publication_date >= $${n}::date`, from);
    if (to) add((n) => `publication_date < ($${n}::date + 1)`, to);

    const page = pageOf(args);
    const rows = await (query ? runSearchQuery : runQuery)(this.db,
      `WITH page AS MATERIALIZED (
         SELECT object_id FROM pl_bzp_notices WHERE ${where.join(' AND ')}
         ORDER BY publication_date DESC, object_id LIMIT ${page.limit + 1} OFFSET ${page.offset}
       )
       SELECT ${NOTICE_COLS} FROM pl_bzp_notices JOIN page USING (object_id)
       ORDER BY pl_bzp_notices.publication_date DESC, object_id`, params);
    return this.wrapResponse(pageResponse(rows, page));
  }

  private async getNotice(args: Record<string, unknown>): Promise<ToolResult> {
    const id = String(args.object_id ?? '').trim();
    if (!id) return this.wrapError('Вкажіть object_id.');
    const rows = await runQuery(this.db,
      `SELECT ${NOTICE_COLS}, html_body, payload FROM pl_bzp_notices WHERE object_id = $1`, [id]);
    if (!rows.length) return this.wrapResponse({ error: 'not_found', object_id: id });
    const { html_body, ...notice } = rows[0];
    return this.wrapResponse({
      ...notice,
      ...sliceText(htmlToText(html_body ?? ''), Number(args.text_offset) || 0, NOTICE_TEXT_CHARS),
    });
  }

  private async searchAssignments(args: Record<string, unknown>): Promise<ToolResult> {
    const signature = String(args.case_signature ?? '').trim().replace(/\s+/g, ' ');
    const judge = String(args.judge ?? '').trim();
    if (!signature && !judge) return this.wrapError('Вкажіть case_signature або judge.');
    const params: unknown[] = [];
    const where: string[] = [];
    if (signature) {
      params.push(signature);
      where.push(`case_signature = $${params.length}`);
    }
    if (judge) {
      params.push(nameVariants(judge));
      where.push(`presiding_judge = ANY($${params.length}::text[])`);
    }
    if (args.court) {
      params.push(`%${this.likeEscape(String(args.court).trim())}%`);
      where.push(`court_name ILIKE $${params.length}`);
    }
    const from = this.dateArg(args.date_from);
    const to = this.dateArg(args.date_to);
    if (from === false || to === false) return this.wrapError('Дати мають бути у форматі YYYY-MM-DD.');
    if (from) {
      params.push(from);
      where.push(`draw_date >= $${params.length}::date`);
    }
    if (to) {
      params.push(to);
      where.push(`draw_date <= $${params.length}::date`);
    }
    const page = pageOf(args);
    const rows = await runQuery(this.db,
      `SELECT draw_date, court_name, department_name, case_signature, category, symbol, draw_result,
              presiding_judge, pool_size, candidates, draw_no, file_name
       FROM pl_slps_draws WHERE ${where.join(' AND ')}
       ORDER BY draw_date DESC, file_name, draw_no LIMIT ${page.limit + 1} OFFSET ${page.offset}`, params);
    return this.wrapResponse(pageResponse(rows, page));
  }

  private async judgeWorkload(args: Record<string, unknown>): Promise<ToolResult> {
    const judge = String(args.judge ?? '').trim();
    if (!judge) return this.wrapError('Вкажіть judge.');
    const params: unknown[] = [nameVariants(judge)];
    let court = '';
    if (args.court) {
      params.push(`%${this.likeEscape(String(args.court).trim())}%`);
      court = 'AND court_name ILIKE $2';
    }
    const rows = await runQuery(this.db,
      `SELECT DISTINCT ON (court_name, department_id) day, full_name, court_name, department_id,
              department_name, in_pool, workload, delegated_77_9
       FROM pl_slps_department_judges WHERE full_name = ANY($1::text[]) ${court}
       ORDER BY court_name, department_id, day DESC LIMIT 100`, params);
    return this.wrapResponse({ results: rows, departments: rows.length });
  }

  private async searchSejm(args: Record<string, unknown>): Promise<ToolResult> {
    const query = String(args.query ?? '').trim();
    if (!query) return this.wrapError('Вкажіть query.');
    const params: unknown[] = [toTsQuery(await wordForms(this.db, query))];
    const where = [`to_tsvector('simple'::regconfig, coalesce(title, '')) @@ $1::tsquery`];
    if (args.kind) {
      if (!SEJM_KINDS.includes(String(args.kind))) return this.wrapError(`kind має бути одним з: ${SEJM_KINDS.join(', ')}.`);
      params.push(String(args.kind));
      where.push(`kind = $${params.length}`);
    }
    if (args.term) {
      params.push(Number(args.term));
      where.push(`term = $${params.length}`);
    }
    const page = pageOf(args);
    const rows = await runQuery(this.db,
      `SELECT kind, term, key, title, changed_at, source_url FROM pl_sejm_objects
       WHERE ${where.join(' AND ')}
       ORDER BY term DESC, changed_at DESC NULLS LAST, kind, key LIMIT ${page.limit + 1} OFFSET ${page.offset}`, params);
    return this.wrapResponse(pageResponse(rows, page));
  }

  private async getSejmObject(args: Record<string, unknown>): Promise<ToolResult> {
    const kind = String(args.kind ?? '');
    const term = Number(args.term);
    const key = String(args.key ?? '');
    if (!SEJM_KINDS.includes(kind) || !term || !key) return this.wrapError('Вкажіть kind, term і key.');
    // Some source keys carry stray spaces (" RPW-16958- 2026/ "), so a trimmed key still finds them.
    const rows = await runQuery(this.db,
      `SELECT kind, term, key, title, changed_at, payload, source_url, fetched_at FROM pl_sejm_objects
       WHERE kind = $1 AND term = $2 AND (key = $3 OR btrim(key) = btrim($3)) LIMIT 1`, [kind, term, key]);
    if (!rows.length) return this.wrapResponse({ error: 'not_found', kind, term, key });
    const row = rows[0];
    if (kind === 'voting' && !args.include_votes && row.payload) {
      const { votes, ...rest } = row.payload;
      row.payload = { ...rest, votes_omitted: Array.isArray(votes) ? votes.length : 0 };
    }
    const size = JSON.stringify(row.payload ?? null).length;
    if (size > MAX_JSON_CHARS) {
      row.payload = JSON.stringify(row.payload).slice(0, MAX_JSON_CHARS);
      row.payload_truncated = true;
      row.payload_total_chars = size;
    }
    return this.wrapResponse(row);
  }

  private async searchRegister(args: Record<string, unknown>): Promise<ToolResult> {
    const register = String(args.register ?? '');
    if (!REGISTERS.includes(register)) return this.wrapError(`register має бути одним з: ${REGISTERS.join(', ')}.`);
    const page = pageOf(args);
    const params: unknown[] = [register];
    let fts = '';
    const query = String(args.query ?? '').trim();
    if (query) {
      params.push(query);
      fts = `AND to_tsvector('simple'::regconfig, data::text) @@ plainto_tsquery('simple'::regconfig, $2)`;
    }
    const rows = await runQuery(this.db,
      `SELECT sheet, row_no, data, source_url, loaded_at FROM pl_opendata_rows
       WHERE source = $1 ${fts}
       ORDER BY sheet, row_no LIMIT ${page.limit + 1} OFFSET ${page.offset}`, params);
    return this.wrapResponse(pageResponse(rows, page, { register }));
  }

  /** undefined when absent, false when malformed, else the date. */
  private dateArg(value: unknown): string | false | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    return isoDate(value) ?? false;
  }

  private likeEscape(value: string): string {
    return value.replace(/[\\%_]/g, '\\$&');
  }
}

