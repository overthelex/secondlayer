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
// Soft deadline for each get_trademark_dossier enrichment sub-tool (they run in parallel),
// well inside the 60 s tool timeout.
const DOSSIER_SUBTOOL_TIMEOUT_MS = 30_000;

// Trademark verbal elements, pulled from raw_data so the display title can be rebuilt
// at read time (see deriveMarkTitle). Only the small jsonb path, not the whole raw_data,
// reaches the client; the helper strips it again before responding.
const VERBAL_COLUMN = `CASE WHEN obj_type = 4
    THEN raw_data->'WordMarkSpecification'->'MarkSignificantVerbalElement' END AS _verbal`;

// Columns returned by the list tools — compact, panel-friendly (no raw_data).
const LIST_COLUMNS = `id, obj_type, obj_type_name, obj_state, app_number, app_date,
  registration_number, registration_date, expiry_date, status, title_ua,
  class_system, classes, owner_name, owner_edrpou, owner_country, owner_kind,
  owner_role, image_path, ${VERBAL_COLUMN}`;

// Collision list caps for get_trademark_dossier: other-owner marks are the real
// blockers and come first; the owner's own family is kept short (LEXAI-2102).
const DOSSIER_COLLISION_FETCH = 40;
const DOSSIER_OTHER_OWNER_MAX = 15;
const DOSSIER_SAME_OWNER_MAX = 5;
const DOSSIER_NICE_SAMPLE_TERMS = 5;

/**
 * Display text of a trademark from its NIPO `MarkSignificantVerbalElement` list (LEXAI-2103).
 *
 * NIPO lists the mark's full phrase AND every word of it as separate elements, e.g.
 * «відновлення», «сила», «моя», «моршинська», «моршинська. моя сила відновлення.».
 * The importer joined them all, so `title_ua` became a token bag. Here an element is
 * dropped when another element already covers it — every word of it occurs in a longer
 * element, it is the same text up to punctuation/case («в.р.к.» vs «врк»), or it is a
 * 1-2 character fragment of a longer one («5» of «а5»). What is left are the genuinely
 * distinct verbal parts (a phrase, a transliteration, a slogan), in NIPO sequence order,
 * joined with « / ». NIPO stores most marks in lower case; the text is kept as given.
 * Falls back to `fallback` when there are no verbal elements.
 */
export function deriveMarkTitle(verbal: unknown, fallback: string | null = null): string | null {
  const list = Array.isArray(verbal) ? verbal : verbal && typeof verbal === 'object' ? [verbal] : [];
  const items = list
    .map((v: any, i: number) => ({
      text: String((typeof v === 'string' ? v : v?.['#text']) ?? '').replace(/\s+/g, ' ').trim(),
      seq: Number(v?.['@sequenceNumber']) || i + 1,
      i,
    }))
    .filter(x => x.text)
    .sort((a, b) => a.seq - b.seq || a.i - b.i)
    .map(x => {
      const lower = x.text.toLowerCase();
      const tokens = lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      return { ...x, lower, tokens, tokenSet: new Set(tokens), compact: tokens.join('') };
    });
  if (items.length === 0) return fallback ?? null;

  const covers = (f: typeof items[number], e: typeof items[number]): boolean => {
    if (f === e) return false;
    if (!e.compact) {
      // symbol-only element («+», «=») — redundant if a longer element contains it
      return f.lower.length > e.lower.length && f.lower.includes(e.lower);
    }
    if (f.compact === e.compact) return f.i < e.i; // same text up to punctuation: keep the first
    if (f.tokens.length > e.tokens.length && e.tokens.every(t => f.tokenSet.has(t))) return true;
    return e.compact.length <= 2 && f.compact.length > e.compact.length && f.compact.includes(e.compact);
  };
  const kept = items.filter(e => !items.some(f => covers(f, e)));
  return kept.map(x => x.text).join(' / ') || fallback || null;
}

/** Replace the stored token-bag title of trademark rows with the derived one; drop _verbal. */
function withMarkTitles<T extends Record<string, any>>(rows: T[]): T[] {
  return rows.map(row => {
    if (!row || !('_verbal' in row)) return row;
    const { _verbal, ...rest } = row as any;
    if (Number(rest.obj_type) === 4 && _verbal != null) {
      rest.title_ua = deriveMarkTitle(_verbal, rest.title_ua ?? null);
    }
    return rest as T;
  });
}

/** Normalise an owner name for same-owner comparison (case, quotes, legal-form noise). */
function normOwnerName(name: unknown): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[«»"'“”„`’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSameOwner(a: any, b: any): boolean {
  if (a?.owner_edrpou && b?.owner_edrpou) return String(a.owner_edrpou) === String(b.owner_edrpou);
  const na = normOwnerName(a?.owner_name);
  return !!na && na === normOwnerName(b?.owner_name);
}

/** Compact Nice-class summary from raw_data (class, term count, first few terms). */
export function niceSummary(raw: any): Array<{ class: string; terms_count: number; sample_terms: string[] }> {
  let cds = raw?.GoodsServicesDetails?.GoodsServices?.ClassDescriptionDetails?.ClassDescription;
  if (cds && !Array.isArray(cds)) cds = [cds];
  if (!Array.isArray(cds)) return [];
  return cds
    .filter((c: any) => c?.ClassNumber != null)
    .map((c: any) => {
      let terms = c.ClassificationTermDetails?.ClassificationTerm;
      if (terms && !Array.isArray(terms)) terms = [terms];
      const texts: string[] = (Array.isArray(terms) ? terms : [])
        .map((t: any) => String(t?.ClassificationTermText ?? '').replace(/\s+/g, ' ').trim().replace(/[.;]$/, ''))
        .filter(Boolean);
      return {
        class: String(c.ClassNumber),
        terms_count: texts.length,
        sample_terms: texts.slice(0, DOSSIER_NICE_SAMPLE_TERMS),
      };
    });
}

/**
 * Short distinctive name to look the mark up in court texts: the first verbal part,
 * as a whole when it is one or two words, else its first word (the brand usually
 * leads: «моршинська. моя сила відновлення.» → «моршинська»).
 */
export function markSearchName(title: string | null | undefined): string | null {
  const first = String(title ?? '').split(' / ')[0];
  const tokens = first.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens.length <= 2) return tokens.join(' ');
  return tokens[0].length >= 3 ? tokens[0] : tokens.slice(0, 2).join(' ');
}

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
      return this.wrapSearchResults(withMarkTitles(result.rows), lim);
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
      return this.wrapSearchResults(withMarkTitles(result.rows), lim);
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
      const [obj] = withMarkTitles(result.rows);
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
  private async callTool(name: string, args: any, timeoutMs?: number): Promise<any> {
    return (await this.callToolDetailed(name, args, timeoutMs)).data;
  }

  /**
   * Like callTool, but says WHY there is no data (timeout / error / unavailable), so the
   * dossier can tell "no court decisions" apart from "the search did not answer".
   */
  private async callToolDetailed(
    name: string, args: any, timeoutMs?: number,
  ): Promise<{ status: 'ok' | 'timeout' | 'error' | 'unavailable'; data: any; error?: string }> {
    if (!this.toolRegistry) return { status: 'unavailable', data: null };
    let timer: NodeJS.Timeout | undefined;
    const TIMEOUT = Symbol('timeout');
    try {
      const call = this.toolRegistry.executeTool(name, args);
      // A soft deadline: the dossier is useful without its enrichment, and one slow
      // sub-tool must not take the whole call past the 60 s tool timeout.
      const res = timeoutMs
        ? await Promise.race([
            call,
            new Promise<typeof TIMEOUT>((resolve) => {
              timer = setTimeout(() => {
                logger.warn(`get_trademark_dossier: sub-tool ${name} exceeded ${timeoutMs} ms, skipped`);
                resolve(TIMEOUT);
              }, timeoutMs);
            }),
          ])
        : await call;
      if (res === TIMEOUT) return { status: 'timeout', data: null };
      if (!res) return { status: 'unavailable', data: null };
      const txt = res.content?.[0]?.text;
      if (res.isError) return { status: 'error', data: null, error: typeof txt === 'string' ? txt.slice(0, 300) : undefined };
      if (typeof txt !== 'string') return { status: 'error', data: null };
      try { return { status: 'ok', data: JSON.parse(txt) }; } catch { return { status: 'ok', data: txt }; }
    } catch (e: any) {
      logger.warn(`get_trademark_dossier: sub-tool ${name} failed`, { error: e.message });
      return { status: 'error', data: null, error: e.message };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Court practice for the dossier (LEXAI-2102). The old probe was one natural-language
   * `fulltext` query built from the token-bag title plus generic words («свідоцтво
   * недійсне торговельна марка»): the LLM distillation dropped the mark entirely, the FTS
   * leg timed out and fell back to hybrid, so the call either missed the 30 s deadline
   * (court_practice: null) or returned generic trademark-law cases unrelated to the mark.
   *
   * Now: deterministic `exact` probes for what identifies THIS mark in a decision text —
   * the application number; the certificate number and the mark name each next to «знак
   * для товарів і послуг»; the mark name next to «торговельна марка» — merged by doc_id.
   * Always returns an object with a results list and, when it is empty, the reason.
   */
  private async courtPracticeForMark(tm: any): Promise<any> {
    const name = markSearchName(tm.title_ua);
    const probes: Array<{ basis: string; query: string }> = [];
    if (tm.app_number) probes.push({ basis: 'app_number', query: String(tm.app_number) });
    if (tm.registration_number) probes.push({ basis: 'registration_number', query: `${tm.registration_number} знак для товарів і послуг` });
    if (name) {
      probes.push({ basis: 'mark_name', query: `${name} торговельна марка` });
      probes.push({ basis: 'mark_name', query: `${name} знак для товарів і послуг` });
    }
    if (probes.length === 0) {
      return { results: [], total: 0, queries: [], note: 'Немає номера чи назви марки для пошуку в ЄДРСР.' };
    }

    const outcomes = await Promise.all(probes.map(p =>
      this.callToolDetailed('search_court_decisions', { mode: 'exact', query: p.query, limit: 10 }, DOSSIER_SUBTOOL_TIMEOUT_MS)));

    const byDoc = new Map<string, any>();
    const queries = probes.map((p, i) => {
      const o = outcomes[i];
      const rows: any[] = Array.isArray(o.data?.results) ? o.data.results : [];
      for (const r of rows) {
        const key = String(r.doc_id ?? r.external_url ?? JSON.stringify(r));
        const prev = byDoc.get(key);
        if (prev) {
          if (!prev.matched_by.includes(p.basis)) prev.matched_by.push(p.basis);
        } else {
          byDoc.set(key, { ...r, matched_by: [p.basis] });
        }
      }
      const status = o.status === 'ok' && o.data?.timed_out ? 'timeout' : o.status;
      return {
        basis: p.basis, query: p.query, status,
        found: o.status === 'ok' ? Number(o.data?.total ?? rows.length) : null,
        ...(o.error ? { error: o.error } : {}),
      };
    });

    // Number matches are the strongest evidence; trademark disputes are mostly commercial
    // (justice_kind 3), so those lead next; then newest first.
    const strength = (r: any) => (r.matched_by.includes('app_number') || r.matched_by.includes('registration_number') ? 1 : 0);
    const commercial = (r: any) => (Number(r.justice_kind) === 3 ? 1 : 0);
    const results = [...byDoc.values()].sort((a, b) =>
      strength(b) - strength(a) || commercial(b) - commercial(a)
      || String(b.adjudication_date ?? '').localeCompare(String(a.adjudication_date ?? '')));

    let note: string;
    if (results.length === 0) {
      const failed = queries.filter(q => q.status !== 'ok');
      note = failed.length === queries.length
        ? `Пошук у ЄДРСР не відповів (${[...new Set(failed.map(q => q.status))].join(', ')}); судову практику не перевірено.`
        : `У ЄДРСР не знайдено рішень, що згадують заявку ${tm.app_number ?? '—'}`
          + (tm.registration_number ? `, свідоцтво ${tm.registration_number}` : '')
          + (name ? ` або позначення «${name}» як торговельну марку` : '')
          + (failed.length ? ` (частина запитів не відповіла: ${failed.map(q => q.query).join('; ')})` : '')
          + '.';
    } else {
      note = 'Збіги за назвою (matched_by: mark_name) можуть стосуватися іншої марки з тим самим словом, а за номером свідоцтва — іншого документа з тим самим номером; перевір текст рішення.';
    }
    return { results, total: results.length, queries, note };
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
                title_ua, owner_name, status, ${VERBAL_COLUMN}
         FROM ip_objects WHERE ${col} = $1 ORDER BY obj_type, obj_state DESC`,
        [number],
      );
      disamb.rows = withMarkTitles(disamb.rows);
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
      // Stored token-bag title: trigram similarity below compares it with the other
      // marks' stored titles, like with like. The response shows the derived title.
      const storedTitle: string | null = card.rows[0].title_ua;
      const [tmFull] = withMarkTitles(card.rows);
      const { raw_data: tmRaw, ...tm } = tmFull;

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
      const legal_status = this.deriveLegalStatus(tmFull, events);
      // raw_data (full goods/services list, addresses) is dropped from the dossier — it was
      // most of the payload. A compact Nice-class summary replaces it (LEXAI-2102).
      const nice_classes = niceSummary(tmRaw);

      // 3. Collision — similar designations in the same МКТП classes (both states, excl. self).
      // Most hits are usually the owner's own family of marks, which are no blocker:
      // flag them same_owner and list other owners' marks first (LEXAI-2102).
      let collisions: any[] = [];
      let collision_summary: any = null;
      if (Array.isArray(tm.classes) && tm.classes.length && storedTitle) {
        try {
          const rows = withMarkTitles((await this.db.query(
            `SELECT ${LIST_COLUMNS}, ROUND(similarity(title_ua, $1)::numeric, 3) AS similarity
             FROM ip_objects
             WHERE obj_type = 4 AND classes && $2::text[]
               AND similarity(title_ua, $1) >= $3 AND app_number <> $4
             ORDER BY similarity(title_ua, $1) DESC LIMIT ${DOSSIER_COLLISION_FETCH}`,
            [storedTitle, tm.classes, 0.3, tm.app_number],
          )).rows).map((r: any) => ({ ...r, same_owner: isSameOwner(tm, r) }));
          const other = rows.filter((r: any) => !r.same_owner);
          const same = rows.filter((r: any) => r.same_owner);
          collisions = [...other.slice(0, DOSSIER_OTHER_OWNER_MAX), ...same.slice(0, DOSSIER_SAME_OWNER_MAX)];
          collision_summary = {
            other_owner: other.length,
            same_owner: same.length,
            shown: collisions.length,
            note: 'Спершу марки інших власників (потенційні блокери), далі — власні марки правовласника (same_owner: true).',
          };
        } catch (e: any) {
          logger.warn('dossier collision failed', { error: e.message });
        }
      }

      // 4-6. Enrichment via other tools (best-effort, null when a service is down or
      // slow). Run in parallel under soft deadlines: one after another, the fulltext court
      // search alone could take the dossier past the 60 s tool timeout, and the caller got
      // nothing — not even the registry card that was already in hand (24.10.2026).
      // app_date comes back as a Date/timestamptz — String(date).slice gives
      // "Tue Apr 04", not "2006-04-04"; normalise to YYYY-MM-DD for as_of_date.
      const filingDate = tm.app_date
        ? (() => { const d = new Date(tm.app_date); return isNaN(d.getTime()) ? String(tm.app_date).slice(0, 10) : d.toISOString().slice(0, 10); })()
        : null;
      const [owner_check, court_practice, article6_as_of_filing, article6_current] = await Promise.all([
        tm.owner_edrpou
          ? this.callTool('openreyestr_get_by_edrpou', { edrpou: tm.owner_edrpou }, DOSSIER_SUBTOOL_TIMEOUT_MS)
          : null,
        this.courtPracticeForMark(tm),
        filingDate
          ? this.callTool('get_legislation_section', {
              rada_id: '3689-12', article_number: '6', as_of_date: filingDate,
            }, DOSSIER_SUBTOOL_TIMEOUT_MS)
          : null,
        filingDate
          ? this.callTool('get_legislation_section', {
              rada_id: '3689-12', article_number: '6',
            }, DOSSIER_SUBTOOL_TIMEOUT_MS)
          : null,
      ]);
      const temporal = filingDate ? { filing_date: filingDate, article6_as_of_filing, article6_current } : null;

      const dossier = {
        query_number: number,
        disambiguation: disamb.rows,
        trademark: { ...tm, nice_classes, events, legal_status },
        collisions,
        collision_summary,
        court_practice,
        temporal,
        owner_check,
        guidance: 'Сформуй повне досьє за розділами: (1) Дизамбігуація та мета; (2) Реєстрові дані та статус; (3) Обсяг охорони (класи МКТП); (4) Правоволодіння; (5) Перевірка на «зіткнення» — таблиця схожих позначень із рівнем ризику, познач найсильніший блокер; (6) Судова практика з ланцюгом інстанцій і статусом позицій; (7) Темпоральний зріз ст. 6 ЗУ №3689-XII (редакція на дату заявки vs чинна); (8) Перевірка правовласника; (9) Підсумок і ризики.',
      };
      return this.wrapResponse(dossier);
    } catch (error: any) {
      logger.error('get_trademark_dossier error', { error: error.message });
      return this.wrapError(`Помилка формування досьє: ${error.message}`);
    }
  }
}
