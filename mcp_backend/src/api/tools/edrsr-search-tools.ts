/**
 * EDRSR Search Tools — Пошук у Єдиному державному реєстрі судових рішень
 *
 * 2 tools:
 * - search_edrsr_decisions — пошук рішень за номером справи, суддею, судом, датою, категорією
 * - get_edrsr_decision_fulltext — отримання повного тексту рішення за doc_id
 *
 * Data: ~82M metadata records, ~78M fulltexts from od.reyestr.court.gov.ua
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';
import { EDRSR_METADATA_SEARCH_ORDER } from '../../services/search-ranking-config.js';
import { formatCourtDate } from '../tool-utils.js';

export class EdsrSearchTools extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'search_edrsr_decisions',
        annotations: { title: 'Пошук рішень ЄДРСР', readOnlyHint: true, openWorldHint: true },
        description: `Пошук судових рішень у Єдиному державному реєстрі судових рішень (ЄДРСР)

Реєстр містить 82+ млн рішень усіх українських судів з 2006 року.
Пошук за номером справи, ПІБ судді, кодом суду, видом судочинства, формою рішення, категорією, датою.
Повертає метадані рішень. Для повного тексту використовуйте get_edrsr_decision_fulltext.
Джерело: data.gov.ua / od.reyestr.court.gov.ua`,
        inputSchema: {
          type: 'object',
          properties: {
            cause_num: {
              type: 'string',
              description: 'Номер справи (наприклад, "922/989/18"). Пошук точний або за входженням.',
            },
            judge: {
              type: 'string',
              description: 'ПІБ судді або частина ПІБ (пошук по входженню, регістронезалежний)',
            },
            court_code: {
              type: 'number',
              description: 'Код суду (з таблиці edrsr_courts)',
            },
            court_name: {
              type: 'string',
              description: 'Назва суду або частина назви (пошук по входженню, регістронезалежний). Наприклад: "Господарський суд Харківської області"',
            },
            justice_kind: {
              type: 'number',
              description: 'Вид судочинства: 1=Цивільне, 2=Кримінальне, 3=Господарське, 4=Адміністративне, 5=Адмінправопорушення',
            },
            judgment_code: {
              type: 'number',
              description: 'Форма рішення: 1=Вирок, 2=Постанова, 3=Рішення, 5=Ухвала, 6=Окрема ухвала, 7=Додаткове рішення, 10=Окрема думка',
            },
            category_code: {
              type: 'number',
              description: `Код категорії справи (з таблиці edrsr_cause_categories).
Найважливіші категорії для військових справ:
  40851=Самовільне залишення частини, 40852=Дезертирство, 40846=Непокора,
  40847=Невиконання наказу, 40752=Ухилення від мобілізації,
  40853=Ухилення (самокалічення), 40867=Недбале ставлення,
  40869=Перевищення влади, 40875=Мародерство,
  40845=Військові кримінальні правопорушення (загальна)`,
            },
            date_from: {
              type: 'string',
              description: 'Дата ухвалення ВІД (формат YYYY-MM-DD)',
            },
            date_to: {
              type: 'string',
              description: 'Дата ухвалення ДО (формат YYYY-MM-DD)',
            },
            instance_code: {
              type: 'number',
              description: 'Інстанція суду: 1=Касаційна, 2=Апеляційна, 3=Перша',
            },
            include_fulltext: {
              type: 'boolean',
              default: false,
              description: 'Включити повний текст рішення (якщо є). Зменшує швидкість, використовуйте лише коли потрібен текст.',
            },
            limit: {
              type: 'number',
              default: 20,
              maximum: 100,
              description: 'Максимальна кількість результатів (за замовчуванням 20)',
            },
            offset: {
              type: 'number',
              default: 0,
              description: 'Зміщення для пагінації',
            },
            military_preset: {
              type: 'string',
              description: `Пресет для військових справ. Автоматично додає justice_kind=2 (кримінальне) та відповідний category_code.
Доступні пресети:
  "awol" — Самовільне залишення частини (ст.407 КК, category_code=40851)
  "desertion" — Дезертирство (ст.408 КК, category_code=40852)
  "insubordination" — Непокора (ст.402 КК, category_code=40846)
  "disobedience" — Невиконання наказу (ст.403 КК, category_code=40847)
  "draft_evasion" — Ухилення від мобілізації (category_code=40752)
  "self_harm" — Ухилення через самокалічення (ст.409 КК, category_code=40853)
  "negligence" — Недбале ставлення (ст.425 КК, category_code=40867)
  "abuse_of_power" — Перевищення влади (ст.426 КК, category_code=40869)
  "looting" — Мародерство (ст.432 КК, category_code=40875)
  "all_military" — Всі військові злочини (category_code IN (40845-40875))`,
            },
          },
          required: [],
        },
      },
      {
        name: 'get_edrsr_decision_fulltext',
        annotations: { title: 'Повний текст рішення ЄДРСР', readOnlyHint: true, idempotentHint: true },
        description: `Отримання повного тексту судового рішення з ЄДРСР за doc_id

Повертає метадані рішення та повний текст (plain text, витягнутий з RTF).
Використовуйте після search_edrsr_decisions, коли потрібен текст конкретного рішення.`,
        inputSchema: {
          type: 'object',
          properties: {
            doc_id: {
              type: ['string', 'number'],
              description: 'ID документа в ЄДРСР',
            },
          },
          required: ['doc_id'],
        },
      },
    ];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    switch (name) {
      case 'search_edrsr_decisions':
        return await this.searchDecisions(args);
      case 'get_edrsr_decision_fulltext':
        return await this.getDecisionFulltext(args);
      default:
        return null;
    }
  }

  // Military preset category codes mapping
  private static readonly MILITARY_PRESETS: Record<string, { category_codes: number[]; label: string }> = {
    'awol':             { category_codes: [40851, 5459, 10660, 12440], label: 'Самовільне залишення частини (ст.407 КК)' },
    'desertion':        { category_codes: [40852, 2050], label: 'Дезертирство (ст.408 КК)' },
    'insubordination':  { category_codes: [40846, 5456], label: 'Непокора (ст.402 КК)' },
    'disobedience':     { category_codes: [40847, 5457], label: 'Невиконання наказу (ст.403 КК)' },
    'draft_evasion':    { category_codes: [40752, 40751, 5390], label: 'Ухилення від мобілізації' },
    'self_harm':        { category_codes: [40853, 5460], label: 'Ухилення через самокалічення (ст.409 КК)' },
    'negligence':       { category_codes: [40867, 2042, 10683], label: 'Недбале ставлення до військової служби (ст.425 КК)' },
    'abuse_of_power':   { category_codes: [40869, 2043, 10682, 11320], label: 'Перевищення влади (ст.426 КК)' },
    'looting':          { category_codes: [40875, 5476], label: 'Мародерство (ст.432 КК)' },
    'all_military':     { category_codes: [40845, 40846, 40847, 40850, 40851, 40852, 40853, 40854, 40855, 40856, 40857, 40862, 40865, 40866, 40867, 40868, 40869, 40871, 40872, 40874, 40875, 40877, 40752, 2039, 2049, 2050, 5459], label: 'Всі військові кримінальні правопорушення' },
  };

  private async searchDecisions(args: any): Promise<ToolResult> {
    const limit = Math.min(Math.max(args.limit || 20, 1), 100);
    const offset = Math.max(args.offset || 0, 0);

    // Apply military preset
    if (args.military_preset && EdsrSearchTools.MILITARY_PRESETS[args.military_preset]) {
      const preset = EdsrSearchTools.MILITARY_PRESETS[args.military_preset];
      args._military_category_codes = preset.category_codes;
      args._military_label = preset.label;
      if (!args.justice_kind) {
        args.justice_kind = 2; // Кримінальне судочинство
      }
    }

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    // Resolve court_name to court_code(s) via lookup
    let resolvedCourtCodes: number[] | null = null;
    if (args.court_name && !args.court_code) {
      try {
        const courtResult = await this.db.query(
          `SELECT court_code FROM edrsr_courts WHERE LOWER(name) LIKE LOWER($1) LIMIT 20`,
          [`%${args.court_name}%`]
        );
        if (courtResult.rows.length > 0) {
          resolvedCourtCodes = courtResult.rows.map((r: any) => r.court_code);
        } else {
          return this.wrapResponse({
            query: args,
            total: 0,
            results: [],
            note: `Суд "${args.court_name}" не знайдено в реєстрі. Спробуйте інший варіант назви.`,
          });
        }
      } catch (err: any) {
        logger.warn('[EdsrSearchTools] Court name lookup failed', { error: err.message });
      }
    }

    if (args.cause_num) {
      conditions.push(`d.cause_num = $${paramIdx}`);
      params.push(args.cause_num);
      paramIdx++;
    }

    if (args.judge) {
      conditions.push(`LOWER(d.judge) LIKE LOWER($${paramIdx})`);
      params.push(`%${args.judge}%`);
      paramIdx++;
    }

    if (args.court_code) {
      conditions.push(`d.court_code = $${paramIdx}`);
      params.push(args.court_code);
      paramIdx++;
    } else if (resolvedCourtCodes && resolvedCourtCodes.length > 0) {
      conditions.push(`d.court_code = ANY($${paramIdx})`);
      params.push(resolvedCourtCodes);
      paramIdx++;
    }

    if (args.justice_kind) {
      conditions.push(`d.justice_kind = $${paramIdx}`);
      params.push(args.justice_kind);
      paramIdx++;
    }

    if (args.judgment_code) {
      conditions.push(`d.judgment_code = $${paramIdx}`);
      params.push(args.judgment_code);
      paramIdx++;
    }

    if (args._military_category_codes && args._military_category_codes.length > 0) {
      conditions.push(`d.category_code = ANY($${paramIdx})`);
      params.push(args._military_category_codes);
      paramIdx++;
    } else if (args.category_code) {
      conditions.push(`d.category_code = $${paramIdx}`);
      params.push(args.category_code);
      paramIdx++;
    }

    if (args.date_from) {
      conditions.push(`d.adjudication_date >= $${paramIdx}`);
      params.push(args.date_from);
      paramIdx++;
    }

    if (args.date_to) {
      conditions.push(`d.adjudication_date <= $${paramIdx}`);
      params.push(args.date_to);
      paramIdx++;
    }

    if (args.instance_code) {
      conditions.push(`c.instance_code = $${paramIdx}`);
      params.push(args.instance_code);
      paramIdx++;
    }

    if (conditions.length === 0) {
      return this.wrapError('Потрібен хоча б один параметр пошуку (cause_num, judge, court_code, court_name, justice_kind, judgment_code, date_from/date_to)');
    }

    const whereClause = conditions.join(' AND ');
    const needsCourtJoin = args.instance_code || args.court_name;
    const includeFulltext = args.include_fulltext === true;

    const fromClause = `edrsr_documents d
      ${needsCourtJoin ? 'LEFT JOIN edrsr_courts c ON c.court_code = d.court_code' : ''}
      ${includeFulltext ? 'LEFT JOIN edrsr_fulltext f ON f.doc_id = d.doc_id' : ''}`;

    const selectFields = `
      d.doc_id, d.cause_num, d.judge, d.court_code, d.justice_kind,
      d.judgment_code, d.category_code, d.adjudication_date, d.receipt_date,
      d.doc_url, d.status, d.date_publ
      ${includeFulltext ? ', f.full_text' : ''}`;

    const executeSearch = async (withFulltext: boolean) => {
      const actualFromClause = `edrsr_documents d
      ${needsCourtJoin ? 'LEFT JOIN edrsr_courts c ON c.court_code = d.court_code' : ''}
      ${withFulltext ? 'LEFT JOIN edrsr_fulltext f ON f.doc_id = d.doc_id' : ''}`;

      const actualSelectFields = `
      d.doc_id, d.cause_num, d.judge, d.court_code, d.justice_kind,
      d.judgment_code, d.category_code, d.adjudication_date, d.receipt_date,
      d.doc_url, d.status, d.date_publ
      ${withFulltext ? ', f.full_text' : ''}`;

      const countSql = `SELECT COUNT(*)::int as total FROM ${actualFromClause} WHERE ${whereClause}`;
      const countResult = await this.db.query(countSql, params);
      const total = countResult.rows[0]?.total || 0;

      const dataSql = `
        SELECT ${actualSelectFields}
        FROM ${actualFromClause}
        WHERE ${whereClause}
        ORDER BY ${EDRSR_METADATA_SEARCH_ORDER}
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;

      const dataResult = await this.db.query(dataSql, [...params, limit, offset]);
      return { total, rows: dataResult.rows };
    };

    try {
      let total: number;
      let rows: any[];

      try {
        ({ total, rows } = await executeSearch(includeFulltext));
      } catch (err: any) {
        // Retry without fulltext JOIN if encoding error (some records have invalid UTF-8 bytes)
        if (includeFulltext && err.code === '22021') {
          logger.warn('[EdsrSearchTools] Retrying without fulltext due to encoding error', { cause_num: args.cause_num });
          ({ total, rows } = await executeSearch(false));
        } else {
          throw err;
        }
      }

      // Enrich with reference data
      const enriched = await this.enrichResults(rows);

      logger.info('[EdsrSearchTools] search_edrsr_decisions', {
        filters: Object.keys(args).filter(k => args[k] !== undefined && k !== 'limit' && k !== 'offset'),
        total,
        returned: enriched.length,
      });

      return this.wrapResponse({
        query: { ...args, _military_category_codes: undefined },
        ...(args._military_label ? { military_filter: args._military_label } : {}),
        total,
        returned: enriched.length,
        offset,
        has_more: offset + enriched.length < total,
        results: enriched,
      });
    } catch (err: any) {
      logger.error('[EdsrSearchTools] search_edrsr_decisions failed', { error: err.message, args });
      return this.wrapError(`Помилка пошуку в ЄДРСР: ${err.message}`);
    }
  }

  private async getDecisionFulltext(args: any): Promise<ToolResult> {
    const docId = args.doc_id;
    if (!docId) return this.wrapError('doc_id є обов\'язковим параметром');

    try {
      const result = await this.db.query(`
        SELECT
          d.doc_id, d.cause_num, d.judge, d.court_code, d.justice_kind,
          d.judgment_code, d.category_code, d.adjudication_date, d.receipt_date,
          d.doc_url, d.status, d.date_publ,
          f.full_text, f.text_length
        FROM edrsr_documents d
        LEFT JOIN edrsr_fulltext f ON f.doc_id = d.doc_id
        WHERE d.doc_id = $1
      `, [docId]);

      if (result.rows.length === 0) {
        // Try fulltext-only (standalone records)
        const ftResult = await this.db.query(
          `SELECT doc_id, full_text, text_length FROM edrsr_fulltext WHERE doc_id = $1`,
          [docId]
        );
        if (ftResult.rows.length === 0) {
          return this.wrapError(`Рішення з doc_id=${docId} не знайдено в ЄДРСР`);
        }
        return this.wrapResponse({
          doc_id: docId,
          full_text: ftResult.rows[0].full_text,
          text_length: ftResult.rows[0].text_length,
          note: 'Метадані відсутні, повернуто лише повний текст',
        });
      }

      const row = result.rows[0];
      const enriched = await this.enrichResults([row]);

      logger.info('[EdsrSearchTools] get_edrsr_decision_fulltext', {
        doc_id: docId,
        has_fulltext: !!row.full_text,
        text_length: row.text_length,
      });

      return this.wrapResponse({
        ...enriched[0],
        full_text: row.full_text || null,
        text_length: row.text_length || (row.full_text ? row.full_text.length : 0),
        has_fulltext: !!row.full_text,
        external_url: `https://reyestr.court.gov.ua/Review/${docId}`,
      });
    } catch (err: any) {
      logger.error('[EdsrSearchTools] get_edrsr_decision_fulltext failed', { error: err.message, doc_id: docId });
      return this.wrapError(`Помилка отримання тексту рішення: ${err.message}`);
    }
  }

  private async enrichResults(rows: any[]): Promise<any[]> {
    if (rows.length === 0) return [];

    // Collect unique codes for batch lookup
    const courtCodes = new Set<number>();
    const justiceKinds = new Set<number>();
    const judgmentCodes = new Set<number>();

    for (const row of rows) {
      if (row.court_code) courtCodes.add(row.court_code);
      if (row.justice_kind) justiceKinds.add(row.justice_kind);
      if (row.judgment_code) judgmentCodes.add(row.judgment_code);
    }

    // Batch lookups
    const [courtsMap, justiceMap, judgmentMap] = await Promise.all([
      this.batchLookup('edrsr_courts', 'court_code', Array.from(courtCodes)),
      this.batchLookup('edrsr_justice_kinds', 'justice_kind', Array.from(justiceKinds)),
      this.batchLookup('edrsr_judgment_forms', 'judgment_code', Array.from(judgmentCodes)),
    ]);

    return rows.map(row => ({
      doc_id: row.doc_id,
      cause_num: row.cause_num,
      judge: row.judge,
      court_code: row.court_code,
      court_name: courtsMap.get(row.court_code) || null,
      justice_kind: row.justice_kind,
      justice_kind_name: justiceMap.get(row.justice_kind) || null,
      judgment_code: row.judgment_code,
      judgment_form: judgmentMap.get(row.judgment_code) || null,
      adjudication_date: formatCourtDate(row.adjudication_date),
      receipt_date: row.receipt_date,
      doc_url: row.doc_url,
      external_url: `https://reyestr.court.gov.ua/Review/${row.doc_id}`,
      ...(row.full_text ? { full_text: row.full_text } : {}),
    }));
  }

  private static readonly ALLOWED_LOOKUP_TABLES: Record<string, Set<string>> = {
    edrsr_courts: new Set(['court_code']),
    edrsr_justice_kinds: new Set(['justice_kind']),
    edrsr_judgment_forms: new Set(['judgment_code']),
  };

  private async batchLookup(table: string, idColumn: string, ids: number[]): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    if (ids.length === 0) return map;
    const allowed = EdsrSearchTools.ALLOWED_LOOKUP_TABLES[table];
    if (!allowed || !allowed.has(idColumn)) return map;

    try {
      const result = await this.db.query(
        `SELECT ${idColumn}, name FROM ${table} WHERE ${idColumn} = ANY($1)`,
        [ids]
      );
      for (const row of result.rows) {
        map.set(row[idColumn], row.name);
      }
    } catch {
      // Reference table might not exist or be empty — non-critical
    }
    return map;
  }
}
