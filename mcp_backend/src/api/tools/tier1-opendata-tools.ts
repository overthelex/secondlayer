/**
 * TIER 1 Open Data Tools — bespoke tools with multi-table query patterns
 *
 * 2 tools:
 * - search_invalid_passports — queries 2 tables (internal + foreign passports)
 * - search_terrorism_list — queries 2 tables (persons + organizations)
 *
 * The other 4 tools formerly here are now served by search_registry (registry-search-tool.ts).
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';

/** Cyrillic letters that look like Latin ones and are stored in Latin in the MVS registry. */
const CYR_TO_LAT: Record<string, string> = {
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O',
  'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'І': 'I',
};

/**
 * Normalise a passport series to the registry's storage form: upper case, no spaces,
 * dots or dashes, Cyrillic look-alikes mapped to Latin. "нм" -> "HM", "СЮ" -> "CЮ"
 * (Ю has no Latin twin and is stored as Cyrillic).
 */
export function normalizePassportSeries(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s\-.]/g, '')
    .replace(/[АВЕКМНОРСТХІ]/g, (ch) => CYR_TO_LAT[ch] ?? ch);
}

/** Case endings stripped from a word before substring matching (longest first). */
const UA_ENDING = /(ОГО|ЕГО|ОМУ|ЕМУ|ИМИ|ІМИ|ІЙ|ИЙ|ІЇ|ОЮ|ЕЮ|ИМ|ІМ|ОЇ|ОМ|ЕМ|АХ|ЯХ|О|А|И|І|Е|У|Ю|Я|Й|Ь)$/;

/**
 * Turn free text ("ВИКРАДЕНО", "ГУНП Київ", "власник розшукується") into ILIKE
 * patterns, one per word, all of which must match. Each word is cut to a rough stem
 * so inflected forms match the registry's wording ("ВИКРАДЕНО" -> "ВИКРАДЕНИЙ",
 * "КИЇВ" -> "М. КИЄВІ"); Ї/Є (Київ/Києві) and apostrophes become single-char wildcards.
 */
export function textTokenPatterns(input: string): string[] {
  const words = input
    .toUpperCase()
    .split(/[\s,.;:!?"«»()/]+/)
    .filter((w) => w.length >= 2);
  return words.map((w) => {
    let stem = w;
    const m = stem.match(UA_ENDING);
    if (m && stem.length - m[1].length >= 4) stem = stem.slice(0, -m[1].length);
    const escaped = stem.replace(/[\\%_]/g, (c) => '\\' + c);
    return `%${escaped.replace(/[ЇЄ'’ʼ`]/g, '_')}%`;
  });
}

function dateKey(d: unknown): number {
  if (!d) return -Infinity;
  const t = new Date(d as any).getTime();
  return Number.isNaN(t) ? -Infinity : t;
}

export class Tier1OpenDataTools extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'search_invalid_passports',
        annotations: { title: 'Недійсні паспорти (МВС)', readOnlyHint: true },
        description: `Перевірка паспорта у реєстрі недійсних документів (МВС)

2.9M внутрішніх + 195K закордонних паспортів. Статуси: ВТРАЧЕНО, ВИЗНАНО НЕДІЙСНИМ, ВИКРАДЕНИЙ,
ВЛАСНИК ДОКУМЕНТА РОЗШУКУЄТЬСЯ тощо. Пошук за серією та номером (кирилиця і латиниця рівнозначні: НМ = HM),
за ОВД або статусом (слова в будь-якій відмінковій формі). total_count — повна кількість збігів.`,
        inputSchema: {
          type: 'object',
          properties: {
            d_series: { type: 'string', description: 'Серія паспорта (напр. АР, ЕН; кирилицею або латиницею)' },
            d_number: { type: 'string', description: 'Номер паспорта' },
            ovd: { type: 'string', description: 'Орган, що вніс запис (слова через пробіл, напр. "ГУНП Київ")' },
            d_status: { type: 'string', description: 'Статус (ВТРАЧЕНО, ВИКРАДЕНО, НЕДІЙСНИМ, РОЗШУКУЄТЬСЯ тощо)' },
            include_foreign: { type: 'boolean', default: true, description: 'Включити закордонні паспорти' },
            limit: { type: 'number', default: 50, maximum: 100, description: 'Макс. результатів' },
          },
        },
      },
      {
        name: 'search_terrorism_list',
        annotations: { title: 'Перелік терористів', readOnlyHint: true },
        description: `Пошук у переліку осіб та організацій пов'язаних з тероризмом (ДСФМУ)

AML/sanctions screening. Перелік ДСФМУ — першоджерело для банків та фінустанов.
Включає фізосіб під санкціями та терористичні організації.`,
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: "Ім'я або назва організації (укр. або англ.)" },
            limit: { type: 'number', default: 50, maximum: 100, description: 'Макс. результатів' },
          },
          required: ['name'],
        },
      },
    ];
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    switch (name) {
      case 'search_invalid_passports': return this.searchInvalidPassports(args);
      case 'search_terrorism_list': return this.searchTerrorismList(args);
      default: return null;
    }
  }

  private async searchInvalidPassports(args: Record<string, unknown>): Promise<ToolResult> {
    const { ovd, d_status, include_foreign = true, limit = 50 } = args as any;
    let series = typeof args.d_series === 'string' ? normalizePassportSeries(args.d_series) : '';
    let number = typeof args.d_number === 'string' || typeof args.d_number === 'number'
      ? String(args.d_number).replace(/[\s-]/g, '') : '';
    // "НМ525271" passed as the number alone: split it into series + number.
    if (!series && number) {
      const m = number.match(/^(\D{1,4})(\d+)$/);
      if (m) { series = normalizePassportSeries(m[1]); number = m[2]; }
    }

    const conditions: string[] = [];
    const values: any[] = [];
    let pi = 1;

    // Plain equality keeps idx_*_series_number usable. Stored series use Latin for every
    // letter that has a Latin look-alike (0 rows with Cyrillic А/В/Е/К/М/Н/О/Р/С/Т/Х/І in
    // either table on 31.10.2026), so the query is normalised the same way.
    if (series) { conditions.push(`d_series = $${pi}`); values.push(series); pi++; }
    if (number) { conditions.push(`d_number = $${pi}`); values.push(number); pi++; }
    for (const [column, input] of [['ovd', ovd], ['d_status', d_status]] as const) {
      if (typeof input !== 'string') continue;
      for (const pattern of textTokenPatterns(input)) {
        conditions.push(`${column} ILIKE $${pi}`); values.push(pattern); pi++;
      }
    }

    if (conditions.length === 0) return this.wrapResponse('Вкажіть серію та номер паспорта для перевірки');

    const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const where = conditions.join(' AND ');

    try {
      const tables: Array<[string, string]> = [['opendata_invalid_passports', 'internal']];
      if (include_foreign) tables.push(['opendata_invalid_passports_foreign', 'foreign']);

      const results: any[] = [];
      const counts: Record<string, number> = {};
      for (const [table, kind] of tables) {
        const page = await this.db.query(
          `SELECT id, d_series, d_number, d_type, d_status, ovd, theft_date, insert_date, '${kind}' as passport_type
           FROM ${table} WHERE ${where} ORDER BY insert_date DESC NULLS LAST LIMIT ${lim}`,
          values
        );
        results.push(...page.rows);
        // The page is capped at `lim`; count separately so OVD/status searches report
        // the real number of matches instead of the page size.
        if (page.rows.length < lim) {
          counts[kind] = page.rows.length;
        } else {
          const c = await this.db.query(`SELECT count(*)::bigint AS n FROM ${table} WHERE ${where}`, values);
          counts[kind] = Number(c.rows[0]?.n ?? page.rows.length);
        }
      }

      if (results.length === 0) {
        const what = series || number ? ` (серія ${series || '—'}, номер ${number || '—'})` : '';
        return this.wrapResponse(`Паспорт не знайдено у реєстрі недійсних документів${what}`);
      }
      results.sort((a, b) => dateKey(b.insert_date) - dateKey(a.insert_date));
      const sliced = results.slice(0, lim);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      return this.wrapResponse({
        results: sliced,
        total_count: total,
        total_by_type: counts,
        has_more: total > sliced.length,
        limit: lim,
        offset: 0,
        ...(series ? { normalized_series: series } : {}),
      });
    } catch (error: any) {
      logger.error('search_invalid_passports error', { error: error.message });
      return this.wrapError(`Помилка пошуку: ${error.message}`);
    }
  }

  private async searchTerrorismList(args: Record<string, unknown>): Promise<ToolResult> {
    const { name, limit = 50 } = args as any;
    if (!name) return this.wrapResponse("Вкажіть ім'я або назву для пошуку");

    const lim = Math.min(Number(limit) || 50, 100);

    try {
      const personsResult = await this.db.query(`
        SELECT 'person' as entity_type, name_ua, name_en, doc_type, sanctions_type, row_data
        FROM opendata_terrorism_persons
        WHERE name_ua ILIKE $1 OR name_en ILIKE $1
        LIMIT $2
      `, [`%${name}%`, lim]);

      const orgsResult = await this.db.query(`
        SELECT 'organization' as entity_type, name_ua, name_en, head_name_ua, head_name_en,
          org_country, report_date, report_num
        FROM opendata_terrorism_orgs
        WHERE name_ua ILIKE $1 OR name_en ILIKE $1 OR name_ua_short ILIKE $1
        LIMIT $2
      `, [`%${name}%`, lim]);

      const results = [...personsResult.rows, ...orgsResult.rows];
      if (results.length === 0) return this.wrapResponse('Осіб/організацій у переліку ДСФМУ не знайдено');
      return this.wrapResponse({
        results,
        total_count: results.length,
        has_more: false,
        limit: lim,
        offset: 0,
      });
    } catch (error: any) {
      logger.error('search_terrorism_list error', { error: error.message });
      return this.wrapError(`Помилка пошуку: ${error.message}`);
    }
  }
}
