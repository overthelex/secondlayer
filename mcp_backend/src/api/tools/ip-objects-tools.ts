/**
 * IP Objects Tools — native search over the unified `ip_objects` table
 * (Ukrainian IP registry harvested from the NIPO/UIPV SIS open-data API:
 * trademarks(4), inventions(1), utility models(2), industrial designs(6),
 * both applications (obj_state=1) and registered documents (obj_state=2)).
 *
 * Three tools:
 *   • search_ip_objects — cross-type search (title, class, owner, type, state)
 *   • search_trademarks — trademark-focused convenience wrapper (Nice classes)
 *   • get_ip_object      — single record by application or registration number
 *
 * Backed by coreServices.db (the same pool the rest of the backend uses,
 * pointing at the DB that holds ip_objects). Read-only.
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';

const OBJ_TYPES = [1, 2, 4, 6];
const OBJ_STATES = [1, 2];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
// Per-source cap for the individual-owner name fan-out in the dossier.
const OWNER_FANOUT_LIMIT = 10;

// Columns returned by the list tools — compact, panel-friendly (no raw_data).
const LIST_COLUMNS = `id, obj_type, obj_type_name, obj_state, app_number, app_date,
  registration_number, registration_date, expiry_date, status, title_ua,
  class_system, classes, owner_name, owner_edrpou, owner_country, owner_kind,
  owner_role, image_path`;

export class IpObjectsTools extends BaseToolHandler {
  // toolRegistry (optional) lets get_trademark_dossier orchestrate other tools
  // (court practice, legislation, owner check) into one deterministic dossier.
  constructor(private db: any, private toolRegistry?: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'search_ip_objects',
        annotations: { title: 'Пошук об’єктів права інтелектуальної власності', readOnlyHint: true },
        description: `Пошук у реєстрі об’єктів права інтелектуальної власності України (НІПО/УІПВ): торговельні марки, винаходи, корисні моделі, промислові зразки — заявки та охоронні документи.

Фільтри (передайте хоча б один): query (текст назви/позначення), obj_type (1=винаходи, 2=корисні моделі, 4=торговельні марки, 6=промислові зразки), obj_state (1=заявка, 2=зареєстровано), classes (масив кодів МКТП/МПК/Локарно), owner (назва власника/заявника), owner_edrpou (код ЄДРПОУ власника).

Приклад: query="Планета", obj_type=4, classes=["34"]
Приклад: owner_edrpou="38565147"`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Текстовий пошук за назвою/позначенням (title_ua)' },
            obj_type: { type: 'number', enum: OBJ_TYPES, description: '1=винаходи, 2=корисні моделі, 4=торговельні марки, 6=промислові зразки' },
            obj_state: { type: 'number', enum: OBJ_STATES, description: '1=заявка, 2=зареєстровано' },
            classes: { type: 'array', items: { type: 'string' }, description: 'Коди класифікації (МКТП для ТМ, МПК для винаходів, Локарно для зразків). Збіг за будь-яким.' },
            owner: { type: 'string', description: 'Назва власника або заявника (частковий збіг)' },
            owner_edrpou: { type: 'string', description: 'Код ЄДРПОУ власника/заявника (для юросіб)' },
            limit: { type: 'number', description: `Макс. результатів (за замовч. ${DEFAULT_LIMIT}, макс. ${MAX_LIMIT})` },
          },
        },
      },
      {
        name: 'search_trademarks',
        annotations: { title: 'Пошук торговельних марок', readOnlyHint: true },
        description: `Пошук саме торговельних марок (свідоцтв на знаки для товарів і послуг) у реєстрі НІПО/УІПВ — заявки та зареєстровані. Спеціалізована обгортка над search_ip_objects з obj_type=4.

Фільтри: query (словесна частина марки), nice_classes (масив класів МКТП), owner, owner_edrpou, obj_state (1=заявка, 2=зареєстровано).

Приклад: query="ELFA", nice_classes=["34"]`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Словесна частина марки (частковий збіг)' },
            nice_classes: { type: 'array', items: { type: 'string' }, description: 'Класи МКТП (Ніццька класифікація). Збіг за будь-яким.' },
            owner: { type: 'string', description: 'Власник або заявник (частковий збіг)' },
            owner_edrpou: { type: 'string', description: 'Код ЄДРПОУ власника' },
            obj_state: { type: 'number', enum: OBJ_STATES, description: '1=заявка, 2=зареєстровано' },
            limit: { type: 'number', description: `Макс. результатів (за замовч. ${DEFAULT_LIMIT}, макс. ${MAX_LIMIT})` },
          },
        },
      },
      {
        name: 'find_similar_trademarks',
        annotations: { title: 'Пошук схожих торговельних марок («зіткнення»)', readOnlyHint: true },
        description: `Пошук тотожних або схожих торговельних марок у тих самих класах МКТП — для перевірки на «зіткнення» (ризик змішування, підстави для відмови за ст. 6 ЗУ №3689-XII).

Передайте АБО app_number (еталонна марка — її словесну частину і класи візьмемо автоматично), АБО query (позначення) РАЗОМ з classes (класи МКТП). Пошук іде і серед заявок, і серед зареєстрованих марок, окрім самої еталонної. Результати відсортовані за схожістю (0..1).

Приклад: app_number="m202401037"
Приклад: query="планета", classes=["34"]`,
        inputSchema: {
          type: 'object',
          properties: {
            app_number: { type: 'string', description: 'Номер заявки еталонної марки (класи й позначення підтягнуться автоматично)' },
            query: { type: 'string', description: 'Позначення для перевірки (якщо немає app_number)' },
            classes: { type: 'array', items: { type: 'string' }, description: 'Класи МКТП (обов’язково разом із query)' },
            obj_state: { type: 'number', enum: OBJ_STATES, description: 'Обмежити: 1=лише заявки, 2=лише зареєстровані (за замовч. обидва)' },
            min_similarity: { type: 'number', description: 'Поріг схожості 0..1 (за замовч. 0.3)' },
            limit: { type: 'number', description: `Макс. результатів (за замовч. ${DEFAULT_LIMIT}, макс. ${MAX_LIMIT})` },
          },
        },
      },
      {
        name: 'get_ip_object',
        annotations: { title: 'Картка об’єкта інтелектуальної власності', readOnlyHint: true },
        description: `Отримати повну картку одного об’єкта ІВ за номером заявки або номером свідоцтва/патенту.

Передайте app_number (напр. "m202410968", "a201500075") АБО registration_number. За потреби уточніть obj_type.`,
        inputSchema: {
          type: 'object',
          properties: {
            app_number: { type: 'string', description: 'Номер заявки' },
            registration_number: { type: 'string', description: 'Номер свідоцтва/патенту' },
            obj_type: { type: 'number', enum: OBJ_TYPES, description: 'Тип об’єкта (для уточнення)' },
          },
        },
      },
      {
        name: 'get_trademark_dossier',
        annotations: { title: 'Повне досьє торговельної марки', readOnlyHint: true },
        description: `Повне ДОСЬЄ торговельної марки за одним номером — все в одному виклику: дизамбігуація номера по реєстрах, реєстрові дані та статус, таймлайн подій, обсяг охорони (класи МКТП), правоволодіння, перевірка на «зіткнення» (схожі позначення в тих самих класах), судова практика (ЄДРСР), темпоральний зріз ст. 6 ЗУ №3689-XII на дату подання заявки vs чинна, та перевірка правовласника.

Викликай ЯВНО, коли користувач просить «досьє»/«досье» на торговельну марку — напр. «дай мені досьє на ТМ 67482», «досье на ТМ 389169». Параметр: number (номер свідоцтва напр. "67482" або заявки напр. "m202422025").`,
        inputSchema: {
          type: 'object',
          properties: {
            number: { type: 'string', description: 'Номер свідоцтва (напр. "67482") або заявки (напр. "m202422025")' },
          },
          required: ['number'],
        },
      },
    ];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    switch (name) {
      case 'search_ip_objects':
        return this.searchIpObjects(args ?? {});
      case 'search_trademarks':
        return this.searchTrademarks(args ?? {});
      case 'find_similar_trademarks':
        return this.findSimilarTrademarks(args ?? {});
      case 'get_ip_object':
        return this.getIpObject(args ?? {});
      case 'get_trademark_dossier':
        return this.getTrademarkDossier(args ?? {});
      default:
        return null;
    }
  }

  private clampLimit(limit: any): number {
    return Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
  }

  private async runSearch(
    conditions: string[],
    values: any[],
    limit: number,
    toolLabel: string,
  ): Promise<ToolResult> {
    if (conditions.length === 0) {
      return this.wrapResponse('Вкажіть хоча б один фільтр для пошуку.');
    }
    const lim = this.clampLimit(limit);
    values.push(lim);
    const sql = `
      SELECT ${LIST_COLUMNS}, COUNT(*) OVER() AS _total_count
      FROM ip_objects
      WHERE ${conditions.join(' AND ')}
      ORDER BY COALESCE(registration_date, app_date) DESC NULLS LAST, id DESC
      LIMIT $${values.length}`;
    try {
      const result = await this.db.query(sql, values);
      if (result.rows.length === 0) {
        return this.wrapResponse('За вказаними критеріями об’єктів не знайдено.');
      }
      return this.wrapSearchResults(result.rows, lim);
    } catch (error: any) {
      logger.error(`${toolLabel} error`, { error: error.message });
      return this.wrapError(`Помилка пошуку: ${error.message}`);
    }
  }

  private async searchIpObjects(args: any): Promise<ToolResult> {
    const conditions: string[] = [];
    const values: any[] = [];

    if (args.query) {
      values.push(`%${args.query}%`);
      conditions.push(`title_ua ILIKE $${values.length}`);
    }
    if (args.obj_type != null) {
      if (!OBJ_TYPES.includes(Number(args.obj_type))) {
        return this.wrapError(`Невірний obj_type. Дозволені: ${OBJ_TYPES.join(', ')}`);
      }
      values.push(Number(args.obj_type));
      conditions.push(`obj_type = $${values.length}`);
    }
    if (args.obj_state != null) {
      if (!OBJ_STATES.includes(Number(args.obj_state))) {
        return this.wrapError(`Невірний obj_state. Дозволені: ${OBJ_STATES.join(', ')}`);
      }
      values.push(Number(args.obj_state));
      conditions.push(`obj_state = $${values.length}`);
    }
    if (Array.isArray(args.classes) && args.classes.length > 0) {
      values.push(args.classes.map((c: any) => String(c)));
      conditions.push(`classes && $${values.length}::text[]`);
    }
    if (args.owner) {
      values.push(`%${args.owner}%`);
      conditions.push(`owner_name ILIKE $${values.length}`);
    }
    if (args.owner_edrpou) {
      values.push(String(args.owner_edrpou));
      conditions.push(`owner_edrpou = $${values.length}`);
    }

    return this.runSearch(conditions, values, args.limit, 'search_ip_objects');
  }

  private async searchTrademarks(args: any): Promise<ToolResult> {
    const conditions: string[] = ['obj_type = 4'];
    const values: any[] = [];

    if (args.query) {
      values.push(`%${args.query}%`);
      conditions.push(`title_ua ILIKE $${values.length}`);
    }
    if (Array.isArray(args.nice_classes) && args.nice_classes.length > 0) {
      values.push(args.nice_classes.map((c: any) => String(c)));
      conditions.push(`classes && $${values.length}::text[]`);
    }
    if (args.owner) {
      values.push(`%${args.owner}%`);
      conditions.push(`owner_name ILIKE $${values.length}`);
    }
    if (args.owner_edrpou) {
      values.push(String(args.owner_edrpou));
      conditions.push(`owner_edrpou = $${values.length}`);
    }
    if (args.obj_state != null) {
      if (!OBJ_STATES.includes(Number(args.obj_state))) {
        return this.wrapError(`Невірний obj_state. Дозволені: ${OBJ_STATES.join(', ')}`);
      }
      values.push(Number(args.obj_state));
      conditions.push(`obj_state = $${values.length}`);
    }

    // obj_type=4 alone is not a user filter; require at least one real criterion.
    if (values.length === 0) {
      return this.wrapResponse('Вкажіть хоча б один фільтр: query, nice_classes, owner або owner_edrpou.');
    }
    return this.runSearch(conditions, values, args.limit, 'search_trademarks');
  }

  private async findSimilarTrademarks(args: any): Promise<ToolResult> {
    let refText: string | undefined = args.query;
    let refClasses: string[] | undefined = Array.isArray(args.classes)
      ? args.classes.map((c: any) => String(c))
      : undefined;
    let excludeApp: string | undefined;

    // Resolve reference mark from an application number, if given.
    if (args.app_number) {
      try {
        const ref = await this.db.query(
          `SELECT title_ua, classes FROM ip_objects WHERE app_number = $1 AND obj_type = 4 LIMIT 1`,
          [String(args.app_number)],
        );
        if (ref.rows.length === 0) {
          return this.wrapResponse(`Еталонну марку за номером заявки "${args.app_number}" не знайдено.`);
        }
        refText = refText || ref.rows[0].title_ua;
        refClasses = refClasses || ref.rows[0].classes;
        excludeApp = String(args.app_number);
      } catch (error: any) {
        logger.error('find_similar_trademarks ref-load error', { error: error.message });
        return this.wrapError(`Помилка завантаження еталонної марки: ${error.message}`);
      }
    }

    if (!refText) {
      return this.wrapError('Вкажіть app_number еталонної марки або query (позначення).');
    }
    if (!refClasses || refClasses.length === 0) {
      return this.wrapError('Пошук «зіткнення» прив’язаний до класів МКТП. Вкажіть classes разом із query (або передайте app_number).');
    }

    const minSim = args.min_similarity != null
      ? Math.max(0, Math.min(Number(args.min_similarity), 1))
      : 0.3;

    const values: any[] = [refText, refClasses, minSim];
    const conditions = [
      'obj_type = 4',
      `classes && $2::text[]`,
      `similarity(title_ua, $1) >= $3`,
    ];
    if (excludeApp) {
      values.push(excludeApp);
      conditions.push(`app_number <> $${values.length}`);
    }
    if (args.obj_state != null) {
      if (!OBJ_STATES.includes(Number(args.obj_state))) {
        return this.wrapError(`Невірний obj_state. Дозволені: ${OBJ_STATES.join(', ')}`);
      }
      values.push(Number(args.obj_state));
      conditions.push(`obj_state = $${values.length}`);
    }

    const lim = this.clampLimit(args.limit);
    values.push(lim);

    const sql = `
      SELECT ${LIST_COLUMNS},
             ROUND(similarity(title_ua, $1)::numeric, 3) AS similarity,
             COUNT(*) OVER() AS _total_count
      FROM ip_objects
      WHERE ${conditions.join(' AND ')}
      ORDER BY similarity(title_ua, $1) DESC, COALESCE(registration_date, app_date) DESC NULLS LAST
      LIMIT $${values.length}`;
    try {
      const result = await this.db.query(sql, values);
      if (result.rows.length === 0) {
        return this.wrapResponse('Схожих марок у тих самих класах не знайдено.');
      }
      return this.wrapSearchResults(result.rows, lim);
    } catch (error: any) {
      logger.error('find_similar_trademarks error', { error: error.message });
      return this.wrapError(`Помилка пошуку: ${error.message}`);
    }
  }

  private async getIpObject(args: any): Promise<ToolResult> {
    const conditions: string[] = [];
    const values: any[] = [];

    if (args.app_number) {
      values.push(String(args.app_number));
      conditions.push(`app_number = $${values.length}`);
    } else if (args.registration_number) {
      values.push(String(args.registration_number));
      conditions.push(`registration_number = $${values.length}`);
    } else {
      return this.wrapError('Вкажіть app_number або registration_number.');
    }
    if (args.obj_type != null) {
      values.push(Number(args.obj_type));
      conditions.push(`obj_type = $${values.length}`);
    }

    const sql = `
      SELECT ${LIST_COLUMNS}, title_en, abstract_ua, bulletin_441_date,
             bulletin_441_number, inventor_names, last_update, raw_data
      FROM ip_objects
      WHERE ${conditions.join(' AND ')}
      ORDER BY obj_state DESC
      LIMIT 1`;
    try {
      const result = await this.db.query(sql, values);
      if (result.rows.length === 0) {
        return this.wrapResponse('Об’єкт не знайдено.');
      }
      const obj = result.rows[0];
      // Lifecycle timeline (продовження / визнання недійсним / припинення) from
      // the classified data_docs events, plus a derived current legal status.
      let events: any[] = [];
      try {
        const ev = await this.db.query(
          `SELECT event_date, event_kind, doc_type, direction, doc_number
           FROM ip_object_events WHERE app_number = $1
           ORDER BY event_date NULLS LAST, id`,
          [obj.app_number],
        );
        events = ev.rows;
      } catch (e: any) {
        logger.warn('get_ip_object events lookup failed', { error: e.message });
      }
      obj.events = events;
      obj.legal_status = this.deriveLegalStatus(obj, events);
      return this.wrapResponse(obj);
    } catch (error: any) {
      logger.error('get_ip_object error', { error: error.message });
      return this.wrapError(`Помилка: ${error.message}`);
    }
  }

  private deriveLegalStatus(obj: any, events: any[]): string {
    const kinds = new Set(events.map(e => e.event_kind));
    // Prefer the SIS dossier fields in raw_data over classified events: event classification is
    // incomplete for older records (e.g. reg. №67482 has only the 3 original 2006 docs, so the
    // termination/prolongation live ONLY in raw_data). Without this, a terminated mark reads as
    // "чинний" (obj_state=2) or, off the stale expiry_date alone, wrongly as "строк дії сплив".
    const raw = obj.raw_data || {};
    if (kinds.has('invalidation')) return 'визнано недійсним';
    if (kinds.has('termination') || raw.TerminationDate) return 'дію припинено';
    if (String(raw.registration_status_color || '').toLowerCase() === 'red') return 'не чинний';
    if (Number(obj.obj_state) === 1) return 'заявка на розгляді';
    // Effective term end = renewed expiry (ProlonagationExpiryDate) if present, else original.
    const effectiveExpiry = raw.ProlonagationExpiryDate || obj.expiry_date;
    if (effectiveExpiry && new Date(effectiveExpiry) < new Date()) return 'строк дії сплив';
    if (Number(obj.obj_state) === 2) return 'чинний';
    return obj.status || 'невідомо';
  }

  /** Best-effort call of another registered tool; returns parsed JSON or null. */
  private async callTool(name: string, args: any): Promise<any> {
    if (!this.toolRegistry) return null;
    try {
      const res = await this.toolRegistry.executeTool(name, args);
      if (!res || res.isError) return null;
      const txt = res.content?.[0]?.text;
      if (typeof txt !== 'string') return null;
      try { return JSON.parse(txt); } catch { return txt; }
    } catch (e: any) {
      logger.warn(`get_trademark_dossier: sub-tool ${name} failed`, { error: e.message });
      return null;
    }
  }

  /**
   * Owner check for the dossier. Legal entities (owner_edrpou present) are
   * resolved deterministically via the state register. Individuals have no
   * РНОКПП in the TM registry, so the only key is the full name — fan out
   * best-effort across public registers and mark everything as name-only
   * probable matches (однофамільці possible; owner_address is attached for
   * manual cross-checking). A downed service never fails the dossier: it is
   * reported as { skipped, reason: 'service_unavailable' } instead of null,
   * so "nothing to check" and "service down" stay distinguishable.
   */
  private async buildOwnerCheck(tm: any): Promise<any> {
    if (tm.owner_edrpou) {
      const entity = await this.callTool('openreyestr_get_by_edrpou', { edrpou: tm.owner_edrpou });
      return entity ?? { skipped: true, reason: 'service_unavailable' };
    }
    const ownerName = String(tm.owner_name ?? '').trim();
    if (!ownerName) return { skipped: true, reason: 'no_owner_identifier' };

    const sources: Array<[key: string, tool: string, args: any]> = [
      ['debtors', 'openreyestr_search_debtors', { query: ownerName, limit: OWNER_FANOUT_LIMIT }],
      ['enforcement_proceedings', 'openreyestr_search_enforcement_proceedings', { query: ownerName, limit: OWNER_FANOUT_LIMIT }],
      ['bankruptcy_cases', 'openreyestr_search_bankruptcy_cases', { query: ownerName, limit: OWNER_FANOUT_LIMIT }],
      ['sanctions', 'search_registry', { registry: 'sanctions', filters: { name: ownerName }, limit: OWNER_FANOUT_LIMIT }],
      // ФОП / участь у юрособах
      ['business_entities', 'openreyestr_search_entities', { query: ownerName, limit: OWNER_FANOUT_LIMIT }],
      // решта портфеля ІВ цього власника
      ['ip_portfolio', 'search_ip_objects', { owner: ownerName, limit: OWNER_FANOUT_LIMIT }],
      ['court_hearings', 'search_court_hearing_schedule', { source: 'opendata', participant: ownerName, limit: OWNER_FANOUT_LIMIT }],
    ];
    const settled = await Promise.all(sources.map(async ([key, toolName, toolArgs]) => {
      const res = await this.callTool(toolName, toolArgs);
      return [key, res ?? { skipped: true, reason: 'service_unavailable' }] as const;
    }));

    return {
      match_basis: 'name_only',
      owner_name: ownerName,
      owner_address: this.extractOwnerAddress(tm.raw_data),
      caveat: 'Збіги знайдено лише за ПІБ — у реєстрі ТМ немає РНОКПП, можливі однофамільці. Звірте owner_address із адресами у знайдених записах вручну.',
      probable_matches: Object.fromEntries(settled),
    };
  }

  /** Owner address lives only in the SIS dossier (raw_data), not in a column. */
  private extractOwnerAddress(raw: any): any {
    const party = raw?.HolderDetails?.Holder?.[0]?.HolderAddressBook
      ?? raw?.ApplicantDetails?.Applicant?.[0]?.ApplicantAddressBook;
    const address = party?.FormattedNameAddress?.Address;
    if (!address) return null;
    return address.FreeFormatAddress?.FreeFormatAddressLine ?? address.FreeFormatAddressLine ?? address;
  }

  /**
   * One-shot full trademark dossier (matches the reference artifact layout):
   * disambiguation → registry card + events + legal_status → collisions →
   * court practice → temporal art.6 → owner check. Registry parts are
   * deterministic (own DB); the last three enrich via other tools if available.
   */
  private async getTrademarkDossier(args: any): Promise<ToolResult> {
    const number = String(args.number ?? args.registration_number ?? args.app_number ?? '').trim();
    if (!number) {
      return this.wrapError('Вкажіть номер свідоцтва або заявки ТМ (параметр number, напр. "67482").');
    }
    // App numbers start with a letter (m/a/u/s); certificate numbers are digits.
    const col = /^[a-z]/i.test(number) ? 'app_number' : 'registration_number';

    try {
      // 1. Disambiguation — every IP object registered under this number.
      const disamb = await this.db.query(
        `SELECT obj_type, obj_type_name, obj_state, app_number, registration_number,
                title_ua, owner_name, status
         FROM ip_objects WHERE ${col} = $1 ORDER BY obj_type, obj_state DESC`,
        [number],
      );
      if (disamb.rows.length === 0) {
        return this.wrapResponse(`Об'єкт з номером «${number}» не знайдено в реєстрі ip_objects.`);
      }

      const tmRow = disamb.rows.find((r: any) => Number(r.obj_type) === 4);
      if (!tmRow) {
        return this.wrapResponse({
          query_number: number,
          note: 'Торговельної марки з таким номером немає; знайдено інші об’єкти права ІВ.',
          disambiguation: disamb.rows,
        });
      }

      // 2. Full trademark card (prefer registered document over application).
      const card = await this.db.query(
        `SELECT ${LIST_COLUMNS}, title_en, raw_data
         FROM ip_objects WHERE ${col} = $1 AND obj_type = 4 ORDER BY obj_state DESC LIMIT 1`,
        [number],
      );
      const tm = card.rows[0];

      let events: any[] = [];
      try {
        events = (await this.db.query(
          `SELECT event_date, event_kind, doc_type, direction
           FROM ip_object_events WHERE app_number = $1 ORDER BY event_date NULLS LAST, id`,
          [tm.app_number],
        )).rows;
      } catch (e: any) {
        logger.warn('dossier events lookup failed', { error: e.message });
      }
      const legal_status = this.deriveLegalStatus(tm, events);

      // 3. Collision — similar designations in the same МКТП classes (both states, excl. self).
      let collisions: any[] = [];
      if (Array.isArray(tm.classes) && tm.classes.length && tm.title_ua) {
        try {
          collisions = (await this.db.query(
            `SELECT ${LIST_COLUMNS}, ROUND(similarity(title_ua, $1)::numeric, 3) AS similarity
             FROM ip_objects
             WHERE obj_type = 4 AND classes && $2::text[]
               AND similarity(title_ua, $1) >= $3 AND app_number <> $4
             ORDER BY similarity(title_ua, $1) DESC LIMIT 15`,
            [tm.title_ua, tm.classes, 0.3, tm.app_number],
          )).rows;
        } catch (e: any) {
          logger.warn('dossier collision failed', { error: e.message });
        }
      }

      // 4-6. Enrichment via other tools (best-effort, skip markers when a service is down).
      const owner_check = await this.buildOwnerCheck(tm);
      const court_practice = await this.callTool('search_court_decisions', {
        mode: 'fulltext', justice_kind: 3, limit: 5,
        query: `${tm.title_ua} свідоцтво недійсне торговельна марка`,
      });
      // app_date comes back as a Date/timestamptz — String(date).slice gives
      // "Tue Apr 04", not "2006-04-04"; normalise to YYYY-MM-DD for as_of_date.
      const filingDate = tm.app_date
        ? (() => { const d = new Date(tm.app_date); return isNaN(d.getTime()) ? String(tm.app_date).slice(0, 10) : d.toISOString().slice(0, 10); })()
        : null;
      const temporal = filingDate ? {
        filing_date: filingDate,
        article6_as_of_filing: await this.callTool('get_legislation_section', {
          rada_id: '3689-12', article_number: '6', as_of_date: filingDate,
        }),
        article6_current: await this.callTool('get_legislation_section', {
          rada_id: '3689-12', article_number: '6',
        }),
      } : null;

      const dossier = {
        query_number: number,
        disambiguation: disamb.rows,
        trademark: { ...tm, events, legal_status },
        collisions,
        court_practice,
        temporal,
        owner_check,
        guidance: 'Сформуй повне досьє за розділами: (1) Дизамбігуація та мета; (2) Реєстрові дані та статус; (3) Обсяг охорони (класи МКТП); (4) Правоволодіння; (5) Перевірка на «зіткнення» — таблиця схожих позначень із рівнем ризику, познач найсильніший блокер; (6) Судова практика з ланцюгом інстанцій і статусом позицій; (7) Темпоральний зріз ст. 6 ЗУ №3689-XII (редакція на дату заявки vs чинна); (8) Перевірка правовласника — якщо owner_check.match_basis="name_only", познач збіги як ймовірні (можливі однофамільці) і запропонуй адресну звірку за owner_address; (9) Підсумок і ризики.',
      };
      return this.wrapResponse(dossier);
    } catch (error: any) {
      logger.error('get_trademark_dossier error', { error: error.message });
      return this.wrapError(`Помилка формування досьє: ${error.message}`);
    }
  }
}
