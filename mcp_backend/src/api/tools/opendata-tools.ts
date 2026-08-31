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

    if (name) { conditions.push(`c.name ILIKE $${pi}`); values.push(`%${name}%`); pi++; }
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

    const sql = `SELECT c.id, c.publisher, c.doc_type, c.date_acc, c.number, c.name, c.status, c.reestr_date, c.keywords${textCol}
      FROM opendata_edrnpa_cards c ${textJoin}
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.reestr_date DESC NULLS LAST
      LIMIT $${pi}`;

    try {
      const result = await this.db.query(sql, values);
      if (result.rows.length === 0) return this.wrapResponse('Нормативних актів не знайдено');
      return this.wrapSearchResults(result.rows, lim);
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

    for (const t of types) {
      const conditions: string[] = [];
      const values: any[] = [];
      let pi = 1;

      if (judge_name) { conditions.push(`judge_name ILIKE $${pi}`); values.push(`%${judge_name}%`); pi++; }
      if (court_name) { conditions.push(`court_name ILIKE $${pi}`); values.push(`%${court_name}%`); pi++; }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      values.push(maxRows);

      if (t === 'dismissed') {
        queries.push(`SELECT 'dismissed' AS type, judge_name, court_name, applicant, reporter,
            panel_decision_date, panel_decision_num, vrp_decision_date_num, NULL AS suspension_reason,
            NULL AS suspension_deadline, NULL AS suspension_body, NULL AS received_date,
            NULL AS case_num, NULL AS check_result, NULL AS reaction
          FROM vrp_dismissed_judges ${where}
          ORDER BY panel_decision_date DESC NULLS LAST LIMIT $${pi}`);
      } else if (t === 'suspended') {
        queries.push(`SELECT 'suspended' AS type, judge_name, court_name, applicant, reporter,
            decision_date AS panel_decision_date, decision_num AS panel_decision_num,
            NULL AS vrp_decision_date_num, suspension_reason, suspension_deadline, suspension_body,
            NULL AS received_date, NULL AS case_num, NULL AS check_result, NULL AS reaction
          FROM vrp_suspended_judges ${where}
          ORDER BY decision_date DESC NULLS LAST LIMIT $${pi}`);
      } else if (t === 'interference') {
        queries.push(`SELECT 'interference' AS type, judge_name, court_name, applicant, reporter,
            NULL AS panel_decision_date, NULL AS panel_decision_num, NULL AS vrp_decision_date_num,
            NULL AS suspension_reason, NULL AS suspension_deadline, NULL AS suspension_body,
            received_date, case_num, check_result, reaction
          FROM vrp_interference_reports ${where}
          ORDER BY received_date DESC NULLS LAST LIMIT $${pi}`);
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
      const sliced = allRows.slice(0, maxRows);
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
