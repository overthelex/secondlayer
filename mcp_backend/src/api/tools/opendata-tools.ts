/**
 * Open Data Tools — bespoke tools with non-parametric query patterns
 *
 * 3 tools that can't be consolidated into search_registry:
 * - search_edrnpa — LEFT JOIN to texts table, conditional column
 * - search_vrp_judges_discipline — queries 3 separate tables (dismissed/suspended/interference)
 * - search_vkks — routes to 5 category-specific sub-queries
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';
import { legislationStems, normalizeApostrophes } from '../../services/legislation-search-utils.js';

/**
 * date_acc / reestr_date are TEXT in DD.MM.YYYY. Ordering by the raw column (the old
 * `ORDER BY c.reestr_date DESC`) sorted by day-of-month, so «31.12.1997» beat
 * «08.12.2025». Rearranged to YYYYMMDD as text: no to_date(), so a malformed value
 * can never raise mid-query.
 */
const EDRNPA_DATE_ORDER =
  `(substr(c.date_acc, 7, 4) || substr(c.date_acc, 4, 2) || substr(c.date_acc, 1, 2)) DESC NULLS LAST, c.id DESC`;

/** c.name lower-cased with apostrophe variants folded to ASCII and whitespace collapsed. */
const EDRNPA_NAME_KEY_SQL =
  `regexp_replace(translate(lower(c.name), 'ʼ’‘', ''''''''), '\\s+', ' ', 'g')`;

/** Amendment acts — «Про внесення змін…», «Про затвердження Змін…». */
const EDRNPA_AMENDMENT_RE = '^\\s*Про (внесення|затвердження) (до .{0,200})?змін';

/** Query-side twin of EDRNPA_NAME_KEY_SQL. Exported for tests. */
export function edrnpaPhraseKey(text: string): string {
  return normalizeApostrophes(String(text ?? '')).toLowerCase().replace(/\s+/g, ' ').trim();
}

const UK_UPPER = 'А-ЯІЇЄҐ';
const UK_LOWER = "а-яіїєґ'’ʼ";
// «Арестової Л.В.», «Князєва В.С.», «Гордієнко-Петрова О. О.» — surname + two initials.
const SURNAME_INITIALS = new RegExp(
  `([${UK_UPPER}][${UK_LOWER}]+(?:-[${UK_UPPER}][${UK_LOWER}]+)?)\\s+([${UK_UPPER}])\\.\\s?([${UK_UPPER}])\\.`,
  'u',
);

/**
 * Pull the judge's name out of a VRP decision title. The name is the first
 * "Surname I.I." after the word «судді» — names before it are complainants or
 * prosecutors («клопотання … Войтенка А.Б. про відсторонення судді … Бондарєва Е.М.»).
 * Returned as written in the title (genitive case); null when there is no such pattern.
 */
export function extractJudgeNameFromDecisionTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const at = title.search(/судді\s/u);
  if (at < 0) return null;
  const m = SURNAME_INITIALS.exec(title.slice(at + 6));
  return m ? `${m[1]} ${m[2]}.${m[3]}.` : null;
}

/** Surname stem for matching a nominative query against a genitive title (Арестова → Арестов). */
export function judgeSurnameStem(query: string): string | null {
  const surname = (query || '').trim().split(/\s+/)[0] || '';
  const stem = surname.replace(/[аяиіоуєїйь]+$/iu, '');
  return stem.length >= 3 ? stem : null;
}

/** Fill a blank judge_name from the linked decision title and say where it came from. */
export function fillJudgeNameFromDecision(row: Record<string, any>): Record<string, any> {
  const own = typeof row.judge_name === 'string' ? row.judge_name.trim() : '';
  const out: Record<string, any> = { ...row, judge_name: own || null };
  if (!own) {
    const parsed = extractJudgeNameFromDecisionTitle(row.vrp_decision_title);
    if (parsed) {
      out.judge_name = parsed;
      out.judge_name_source = 'vrp_decision_title';
      out.judge_name_note = 'ПІБ узято з назви рішення ВРП (родовий відмінок)';
    }
  }
  if (out.vrp_decision_title == null) delete out.vrp_decision_title;
  return out;
}

export class OpenDataTools extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'search_edrnpa',
        annotations: { title: 'НПА (ЄДРНПА)', readOnlyHint: true },
        description: `Пошук нормативно-правових актів у ЄДРНПА

141K записів. Пошук за назвою, номером, видавником, типом, ключовими словами.
Повертає метадані та повний текст документів.`,
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Назва або ключові слова акта' },
            number: { type: 'string', description: 'Номер акта' },
            publisher: { type: 'string', description: 'Видавник (орган)' },
            doc_type: { type: 'string', description: 'Тип документа (наказ, постанова, рішення)' },
            keywords: { type: 'string', description: 'Ключові слова' },
            include_text: { type: 'boolean', default: false, description: 'Включити повний текст (перші 3000 символів)' },
            limit: { type: 'number', default: 50, maximum: 100, description: 'Макс. результатів' },
          },
        },
      },
      {
        name: 'search_vrp_judges_discipline',
        annotations: { title: 'Дисциплінарні дані суддів (ВРП)', readOnlyHint: true },
        description: `Пошук дисциплінарних даних суддів з ВРП

Об'єднаний пошук по 3 реєстрах:
- Звільнені судді (59 записів)
- Відсторонені судді (236 записів)
- Повідомлення про втручання (443 записів)
Пошук за ПІБ судді, назвою суду, типом запису.`,
        inputSchema: {
          type: 'object',
          properties: {
            judge_name: { type: 'string', description: 'ПІБ судді (нечіткий пошук)' },
            court_name: { type: 'string', description: 'Назва суду (нечіткий пошук)' },
            type: { type: 'string', enum: ['dismissed', 'suspended', 'interference'], description: 'Тип: dismissed (звільнені), suspended (відсторонені), interference (втручання). Без фільтра — всі типи' },
            limit: { type: 'number', default: 50, maximum: 100, description: 'Макс. результатів' },
          },
        },
      },
      {
        name: 'search_vkks',
        annotations: { title: 'Дані ВККС', readOnlyHint: true },
        description: `Пошук даних Вищої кваліфікаційної комісії суддів (ВККС)

5 категорій:
- judges — досьє суддів (4.7K записів)
- evaluations — оцінювання суддів (3.4K записів)
- declarations — декларації суддів (4.8K записів)
- vacancies — вакансії у судах (1K записів)
- efficiency — ефективність суддів (10.7K записів)

Обов'язковий параметр: category.`,
        inputSchema: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: ['judges', 'evaluations', 'declarations', 'vacancies', 'efficiency'], description: "Категорія даних ВККС (обов'язково)" },
            judge_name: { type: 'string', description: 'ПІБ судді (для judges, evaluations, declarations, efficiency)' },
            court_name: { type: 'string', description: 'Назва суду' },
            year: { type: 'number', description: 'Рік (для declarations, efficiency)' },
            region: { type: 'string', description: 'Регіон (для vacancies)' },
            court_level: { type: 'string', description: 'Рівень суду (для vacancies, efficiency)' },
            dossier_number: { type: 'string', description: 'Номер досьє (для judges, evaluations)' },
            limit: { type: 'number', default: 50, maximum: 100, description: 'Макс. результатів' },
          },
          required: ['category'],
        },
      },
    ];
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    switch (name) {
      case 'search_edrnpa': return this.searchEdrnpa(args);
      case 'search_vrp_judges_discipline': return this.searchVrpJudgesDiscipline(args);
      case 'search_vkks': return this.searchVkks(args);
      default: return null;
    }
  }

  // ─── EDRNPA ──────────────────────────────────────────────────────────

  private async searchEdrnpa(args: Record<string, unknown>): Promise<ToolResult> {
    const { name, number, publisher, doc_type, keywords, include_text = false, limit = 50 } = args as any;
    const conditions: string[] = [];
    const values: any[] = [];
    let pi = 1;

    // Word-level name match (LEXAI-2100). `c.name ILIKE '%phrase%'` was an exact
    // substring: «бронювання військовозобов'язаних» typed with an ASCII apostrophe never
    // matched the КМУ постанова 76/2023 stored with ʼ (U+02BC), and any word between
    // the two terms in a title broke the match too. Each content stem is now matched on
    // its own; the stems never contain an apostrophe, so the variant does not matter.
    // A seq scan over 141K names takes ~0.1-0.2 s — no index needed.
    // Stems are letters/digits only (see legislationStems), so no LIKE escaping is needed.
    let nameStems: string[] = [];
    let minMatchIdx = 0;
    let orderBy = EDRNPA_DATE_ORDER;
    if (name) {
      nameStems = legislationStems(normalizeApostrophes(String(name)));
      if (nameStems.length === 0) {
        // Only stopwords/short tokens — fall back to the literal substring.
        conditions.push(`c.name ILIKE $${pi}`); values.push(`%${name}%`); pi++;
      } else {
        // Inline sum of per-stem ILIKEs: an unnest() subquery per row cost ~7x more
        // over the full-table scan.
        const terms: string[] = [];
        for (const s of nameStems) { terms.push(`(c.name ILIKE $${pi})::int`); values.push(`%${s}%`); pi++; }
        const matchedSql = `(${terms.join(' + ')})`;
        minMatchIdx = pi; values.push(nameStems.length); pi++;
        conditions.push(`${matchedSql} >= $${minMatchIdx}`);
        const phraseIdx = pi; values.push(edrnpaPhraseKey(String(name))); pi++;
        // Exact phrase (apostrophes/whitespace folded) first, then how many of the
        // terms the name carries (matters only in the relaxed pass), amending acts
        // («Про внесення змін до…») after the acts they amend, then newest.
        orderBy = `strpos(${EDRNPA_NAME_KEY_SQL}, $${phraseIdx}) > 0 DESC, ${matchedSql} DESC, `
          + `(c.name ~* '${EDRNPA_AMENDMENT_RE}') ASC, ${EDRNPA_DATE_ORDER}`;
      }
    }
    // Normalised on BOTH sides. c.number = $n was raw equality against a column
    // holding 5 435 NULLs, 97 zero-padded numbers ("007"), 11 929 with Roman
    // characters, and shapes like 08-а, 02/01, 1-зп, 10-VII — so a user typing
    // «7» never found «007» and a Cyrillic-typed Roman never matched a Latin
    // one. Index: idx_edrnpa_number_norm (migration 189).
    if (number) { conditions.push(`npa.norm_number(c.number) = npa.norm_number($${pi})`); values.push(String(number)); pi++; }
    if (publisher) { conditions.push(`c.publisher ILIKE $${pi}`); values.push(`%${publisher}%`); pi++; }
    if (doc_type) { conditions.push(`c.doc_type ILIKE $${pi}`); values.push(`%${doc_type}%`); pi++; }
    if (keywords) { conditions.push(`c.keywords ILIKE $${pi}`); values.push(`%${keywords}%`); pi++; }

    if (conditions.length === 0) return this.wrapResponse('Вкажіть назву, номер або видавника для пошуку');

    const lim = Math.min(Number(limit) || 50, 100);
    values.push(lim);

    const textJoin = include_text
      ? `LEFT JOIN opendata_edrnpa_texts t ON t.id = c.id`
      : '';
    const textCol = include_text
      ? `, LEFT(t.full_text, 3000) AS full_text`
      : '';

    const sql = `SELECT c.id, c.publisher, c.doc_type, c.date_acc, c.number, c.name, c.status, c.reestr_date, c.keywords${textCol},
             COUNT(*) OVER() AS _total_count
      FROM opendata_edrnpa_cards c ${textJoin}
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT $${pi}`;

    try {
      let result = await this.db.query(sql, values);
      let relaxed = false;
      // AND over all name terms first; a thin result relaxes to "most of the terms"
      // (ranked by how many match), same relax pattern as search_npa. Not with a
      // number: name + number is a lookup, and one exact hit is the right answer.
      if (result.rows.length < 3 && nameStems.length > 1 && !number) {
        const relaxedValues = [...values];
        relaxedValues[minMatchIdx - 1] = Math.ceil(nameStems.length / 2);
        const relaxedResult = await this.db.query(sql, relaxedValues);
        if (relaxedResult.rows.length > result.rows.length) { result = relaxedResult; relaxed = true; }
      }
      if (result.rows.length === 0) return this.wrapResponse('Нормативних актів не знайдено');
      if (!relaxed) return this.wrapSearchResults(result.rows, lim);
      const total = Number(result.rows[0]._total_count ?? result.rows.length);
      const cleaned = result.rows.map(({ _total_count, ...rest }: any) => rest);
      return this.wrapResponse({
        note: 'За всіма словами назви знайдено замало актів — показано акти, що містять більшість слів.',
        results: cleaned,
        total_count: total,
        has_more: cleaned.length < total,
        limit: lim,
        offset: 0,
      });
    } catch (error: any) {
      logger.error('search_edrnpa error', { error: error.message });
      return this.wrapError(`Помилка пошуку: ${error.message}`);
    }
  }

  // ─── VRP Judges Discipline ──────────────────────────────────────────

  private async searchVrpJudgesDiscipline(args: Record<string, unknown>): Promise<ToolResult> {
    const { judge_name, court_name, type, limit = 50 } = args as any;
    const maxRows = Math.min(Number(limit) || 50, 100);
    const queries: string[] = [];
    const allValues: any[][] = [];

    const types = type ? [type] : ['dismissed', 'suspended', 'interference'];

    // LEXAI-2108: judge_name is empty in all 738 rows of the three VRP registers (the
    // import never filled it). The name survives only in the title of the linked VRP
    // decision («Про притягнення … судді <суду> Арестової Л.В.»), reachable by decision
    // number through vrp_decisions (idx_vrp_decisions_decision_num). That table starts in
    // 2023-11, so suspensions from 2024 resolve and the 2018–2020 dismissals do not —
    // those keep judge_name null rather than a guess.
    const decisionJoin = (numExpr: string) => `LEFT JOIN LATERAL (
          SELECT vd.title FROM vrp_decisions vd
          WHERE vd.decision_num = ${numExpr}
          ORDER BY vd.date_time DESC NULLS LAST LIMIT 1) d ON true`;
    const dismissedNum = `NULLIF(btrim(substring(t.vrp_decision_date_num from '№\\s*(\\S+)')), '')`;
    const panelNum = (col: string) => `NULLIF(btrim(regexp_replace(${col}, '^№\\s*', '')), '')`;

    for (const t of types) {
      const conditions: string[] = [];
      const values: any[] = [];
      let pi = 1;

      const hasDecision = t === 'dismissed' || t === 'suspended';
      if (judge_name) {
        // Decision titles carry the name in the genitive (Арестова → Арестової), so the
        // title is matched on the surname stem.
        const stem = judgeSurnameStem(String(judge_name));
        if (hasDecision && stem) {
          conditions.push(`(t.judge_name ILIKE $${pi} OR d.title ILIKE $${pi + 1})`);
          values.push(`%${judge_name}%`, `%судді%${stem}%`);
          pi += 2;
        } else {
          conditions.push(`t.judge_name ILIKE $${pi}`); values.push(`%${judge_name}%`); pi++;
        }
      }
      if (court_name) { conditions.push(`t.court_name ILIKE $${pi}`); values.push(`%${court_name}%`); pi++; }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      values.push(maxRows);

      if (t === 'dismissed') {
        queries.push(`SELECT 'dismissed' AS type, t.judge_name, t.court_name, t.applicant, t.reporter,
            t.panel_decision_date, t.panel_decision_num, t.vrp_decision_date_num, NULL AS suspension_reason,
            NULL AS suspension_deadline, NULL AS suspension_body, NULL AS received_date,
            NULL AS case_num, NULL AS check_result, NULL AS reaction,
            COALESCE(d.title, dp.title) AS vrp_decision_title
          FROM vrp_dismissed_judges t
          ${decisionJoin(dismissedNum)}
          LEFT JOIN LATERAL (
            SELECT vd.title FROM vrp_decisions vd
            WHERE vd.decision_num = ${panelNum('t.panel_decision_num')}
            ORDER BY vd.date_time DESC NULLS LAST LIMIT 1) dp ON true
          ${where}
          ORDER BY t.panel_decision_date DESC NULLS LAST LIMIT $${pi}`);
      } else if (t === 'suspended') {
        queries.push(`SELECT 'suspended' AS type, t.judge_name, t.court_name, t.applicant, t.reporter,
            t.decision_date AS panel_decision_date, t.decision_num AS panel_decision_num,
            NULL AS vrp_decision_date_num, t.suspension_reason, t.suspension_deadline, t.suspension_body,
            NULL AS received_date, NULL AS case_num, NULL AS check_result, NULL AS reaction,
            d.title AS vrp_decision_title
          FROM vrp_suspended_judges t
          ${decisionJoin(panelNum('t.decision_num'))}
          ${where}
          ORDER BY t.decision_date DESC NULLS LAST LIMIT $${pi}`);
      } else if (t === 'interference') {
        queries.push(`SELECT 'interference' AS type, t.judge_name, t.court_name, t.applicant, t.reporter,
            NULL AS panel_decision_date, NULL AS panel_decision_num, NULL AS vrp_decision_date_num,
            NULL AS suspension_reason, NULL AS suspension_deadline, NULL AS suspension_body,
            t.received_date, t.case_num, t.check_result, t.reaction, NULL AS vrp_decision_title
          FROM vrp_interference_reports t ${where}
          ORDER BY t.received_date DESC NULLS LAST LIMIT $${pi}`);
      }
      allValues.push(values);
    }

    if (queries.length === 0) return this.wrapResponse('Невідомий тип запису');

    try {
      const allRows: any[] = [];
      for (let i = 0; i < queries.length; i++) {
        const result = await this.db.query(queries[i], allValues[i]);
        allRows.push(...result.rows);
      }

      if (allRows.length === 0) return this.wrapResponse('Дисциплінарних записів не знайдено');
      const sliced = allRows.slice(0, maxRows).map(fillJudgeNameFromDecision);
      return this.wrapResponse({
        results: sliced,
        total_count: allRows.length,
        has_more: allRows.length > maxRows,
        limit: maxRows,
        offset: 0,
      });
    } catch (error: any) {
      logger.error('search_vrp_judges_discipline error', { error: error.message });
      return this.wrapError(`Помилка пошуку: ${error.message}`);
    }
  }

  // ─── VKKS ──────────────────────────────────────────────────────────

  private async searchVkks(args: Record<string, unknown>): Promise<ToolResult> {
    const { category, judge_name, court_name, year, region, court_level, dossier_number, limit = 50 } = args as any;

    if (!category) return this.wrapResponse('Вкажіть category: judges, evaluations, declarations, vacancies, efficiency');

    const maxRows = Math.min(Number(limit) || 50, 100);

    switch (category) {
      case 'judges': return this.searchVkksJudges({ judge_name, court_name, dossier_number, limit: maxRows });
      case 'evaluations': return this.searchVkksEvaluations({ judge_name, court_name, dossier_number, limit: maxRows });
      case 'declarations': return this.searchVkksDeclarations({ judge_name, court_name, year, limit: maxRows });
      case 'vacancies': return this.searchVkksVacancies({ court_name, region, court_level, limit: maxRows });
      case 'efficiency': return this.searchVkksEfficiency({ judge_name, court_name, court_level, year, limit: maxRows });
      default: return this.wrapResponse('Невідома категорія. Доступні: judges, evaluations, declarations, vacancies, efficiency');
    }
  }

  private async searchVkksJudges(args: any): Promise<ToolResult> {
    const { judge_name, court_name, dossier_number, limit } = args;
    const conditions: string[] = [];
    const values: any[] = [];
    let pi = 1;

    if (judge_name) { conditions.push(`full_name ILIKE $${pi}`); values.push(`%${judge_name}%`); pi++; }
    if (court_name) { conditions.push(`court_name ILIKE $${pi}`); values.push(`%${court_name}%`); pi++; }
    if (dossier_number) { conditions.push(`dossier_number = $${pi}`); values.push(dossier_number); pi++; }

    if (conditions.length === 0) return this.wrapResponse('Вкажіть ПІБ судді, суд або номер досьє');

    values.push(limit);
    const sql = `SELECT id, dossier_number, full_name, gender, court_name, source_date, COUNT(*) OVER() AS _total_count
      FROM vkks_judges WHERE ${conditions.join(' AND ')}
      ORDER BY full_name LIMIT $${pi}`;

    try {
      const result = await this.db.query(sql, values);
      if (result.rows.length === 0) return this.wrapResponse('Суддів у ВККС не знайдено');
      return this.wrapSearchResults(result.rows, limit);
    } catch (error: any) {
      logger.error('search_vkks_judges error', { error: error.message });
      return this.wrapError(`Помилка пошуку: ${error.message}`);
    }
  }

  private async searchVkksEvaluations(args: any): Promise<ToolResult> {
    const { judge_name, court_name, dossier_number, limit } = args;
    const conditions: string[] = [];
    const values: any[] = [];
    let pi = 1;

    if (judge_name) { conditions.push(`judge_name ILIKE $${pi}`); values.push(`%${judge_name}%`); pi++; }
    if (court_name) { conditions.push(`court_name ILIKE $${pi}`); values.push(`%${court_name}%`); pi++; }
    if (dossier_number) { conditions.push(`dossier_number = $${pi}`); values.push(dossier_number); pi++; }

    if (conditions.length === 0) return this.wrapResponse('Вкажіть ПІБ судді, суд або номер досьє');

    values.push(limit);
    const sql = `SELECT id, dossier_number, judge_name, court_name, collegium_decision_date,
        collegium_decision_number, total_score, collegium_decision_essence, plenary_decision_date,
        plenary_decision_number, plenary_decision_essence, evaluation_type, decision_url, notes, COUNT(*) OVER() AS _total_count
      FROM vkks_evaluations WHERE ${conditions.join(' AND ')}
      ORDER BY collegium_decision_date DESC NULLS LAST LIMIT $${pi}`;

    try {
      const result = await this.db.query(sql, values);
      if (result.rows.length === 0) return this.wrapResponse('Оцінювань суддів не знайдено');
      return this.wrapSearchResults(result.rows, limit);
    } catch (error: any) {
      logger.error('search_vkks_evaluations error', { error: error.message });
      return this.wrapError(`Помилка пошуку: ${error.message}`);
    }
  }

  private async searchVkksDeclarations(args: any): Promise<ToolResult> {
    const { judge_name, court_name, year, limit } = args;
    const conditions: string[] = [];
    const values: any[] = [];
    let pi = 1;

    if (judge_name) { conditions.push(`judge_name ILIKE $${pi}`); values.push(`%${judge_name}%`); pi++; }
    if (court_name) { conditions.push(`court_name ILIKE $${pi}`); values.push(`%${court_name}%`); pi++; }
    if (year) { conditions.push(`year = $${pi}`); values.push(Number(year)); pi++; }

    if (conditions.length === 0) return this.wrapResponse('Вкажіть ПІБ судді, суд або рік');

    values.push(limit);
    const sql = `SELECT id, judge_name, court_name, declaration_type, year, source, COUNT(*) OVER() AS _total_count
      FROM vkks_declarations WHERE ${conditions.join(' AND ')}
      ORDER BY year DESC, judge_name LIMIT $${pi}`;

    try {
      const result = await this.db.query(sql, values);
      if (result.rows.length === 0) return this.wrapResponse('Декларацій суддів не знайдено');
      return this.wrapSearchResults(result.rows, limit);
    } catch (error: any) {
      logger.error('search_vkks_declarations error', { error: error.message });
      return this.wrapError(`Помилка пошуку: ${error.message}`);
    }
  }

  private async searchVkksVacancies(args: any): Promise<ToolResult> {
    const { court_name, region, court_level, limit } = args;
    const conditions: string[] = [];
    const values: any[] = [];
    let pi = 1;

    if (court_name) { conditions.push(`court_name ILIKE $${pi}`); values.push(`%${court_name}%`); pi++; }
    if (region) { conditions.push(`region ILIKE $${pi}`); values.push(`%${region}%`); pi++; }
    if (court_level) { conditions.push(`court_level ILIKE $${pi}`); values.push(`%${court_level}%`); pi++; }

    if (conditions.length === 0) return this.wrapResponse('Вкажіть назву суду, регіон або рівень суду');

    values.push(limit);
    const sql = `SELECT id, court_name, court_level, region, positions_limit, positions_filled,
        positions_vacant, positions_in_process, report_date, COUNT(*) OVER() AS _total_count
      FROM vkks_vacancies WHERE ${conditions.join(' AND ')}
      ORDER BY report_date DESC NULLS LAST LIMIT $${pi}`;

    try {
      const result = await this.db.query(sql, values);
      if (result.rows.length === 0) return this.wrapResponse('Вакансій у судах не знайдено');
      return this.wrapSearchResults(result.rows, limit);
    } catch (error: any) {
      logger.error('search_vkks_vacancies error', { error: error.message });
      return this.wrapError(`Помилка пошуку: ${error.message}`);
    }
  }

  private async searchVkksEfficiency(args: any): Promise<ToolResult> {
    const { judge_name, court_name, court_level, year, limit } = args;
    const conditions: string[] = [];
    const values: any[] = [];
    let pi = 1;

    if (judge_name) { conditions.push(`judge_name ILIKE $${pi}`); values.push(`%${judge_name}%`); pi++; }
    if (court_name) { conditions.push(`court_name ILIKE $${pi}`); values.push(`%${court_name}%`); pi++; }
    if (court_level) { conditions.push(`court_level ILIKE $${pi}`); values.push(`%${court_level}%`); pi++; }
    if (year) { conditions.push(`year = $${pi}`); values.push(Number(year)); pi++; }

    if (conditions.length === 0) return this.wrapResponse('Вкажіть ПІБ судді, суд, рівень або рік');

    values.push(limit);
    const sql = `SELECT id, judge_name, court_name, court_level, year,
        workload_total_judge, workload_total_court, workload_total_region,
        workload_criminal_judge, workload_civil_judge, workload_admin_judge,
        workload_commercial_judge, workload_offense_judge,
        annulled_total, changed_total, overdue_cases_total, COUNT(*) OVER() AS _total_count
      FROM vkks_judge_efficiency WHERE ${conditions.join(' AND ')}
      ORDER BY year DESC, judge_name LIMIT $${pi}`;

    try {
      const result = await this.db.query(sql, values);
      if (result.rows.length === 0) return this.wrapResponse('Даних про ефективність суддів не знайдено');
      return this.wrapSearchResults(result.rows, limit);
    } catch (error: any) {
      logger.error('search_vkks_efficiency error', { error: error.message });
      return this.wrapError(`Помилка пошуку: ${error.message}`);
    }
  }
}
