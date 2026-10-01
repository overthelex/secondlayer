/**
 * Analyze Data Tool — read-only SQL escape hatch for analytical queries.
 *
 * Allows GROUP BY, COUNT, aggregations, and analytical JOINs that
 * parametric search tools can't express. Enforced read-only via
 * SET TRANSACTION READ ONLY + statement_timeout + table whitelist.
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';

const STATEMENT_TIMEOUT_MS = 30_000;
const MAX_ROWS = 500;

const ALLOWED_TABLES: Set<string> = new Set([
  // EDRSR court decisions
  'edrsr_documents', 'edrsr_fulltext', 'edrsr_courts', 'edrsr_justice_kinds',
  'edrsr_judgment_forms', 'edrsr_cause_categories',
  // Open data registries
  'opendata_public_organizations', 'opendata_missing_persons', 'opendata_wanted_persons',
  'opendata_wanted_vehicles', 'opendata_court_experts', 'opendata_vat_payers',
  'opendata_securities_owners', 'opendata_corruption', 'opendata_lawyers',
  'opendata_declaration_checks', 'opendata_wage_debtors', 'opendata_large_taxpayers',
  'opendata_trademarks', 'opendata_patents', 'opendata_vehicle_registrations',
  'opendata_lustration', 'opendata_state_aid', 'opendata_financial_statements',
  'opendata_invalid_passports', 'opendata_invalid_passports_foreign',
  'opendata_terrorism_persons', 'opendata_terrorism_orgs',
  'opensanctions_entities',
  // Court schedules and status
  'opendata_court_schedule', 'opendata_court_case_status',
  'dsa_case_distribution',
  // VRP/VKKS
  'vrp_decisions', 'vrp_dismissed_judges', 'vrp_suspended_judges', 'vrp_interference_reports',
  'vkks_judges', 'vkks_evaluations', 'vkks_declarations', 'vkks_vacancies', 'vkks_judge_efficiency',
  // Judges
  'judges', 'judges_current',
  // Banks
  'nbu_banks',
  // Public spending
  'opendata_spending_state', 'opendata_spending_local',
  // EDRNPA
  'opendata_edrnpa_cards', 'opendata_edrnpa_texts',
  // UK — legislation.gov.uk (OGL v3.0) and Find Case Law
  'uk_legislation', 'uk_legislation_versions', 'uk_legislation_provisions',
  'uk_legislation_effects', 'uk_legislation_amendment_history',
  // uk_court_decisions is deliberately absent: Find Case Law judgments are only for
  // verified users (uk-judgment-access.ts), and raw SQL here bypasses that gate and the
  // hidden list. TNA licence CAS-349914-B9P5B8, principles 6-7.
]);

// Functions that run SQL from a string (so the plan cannot see the tables they read),
// or that reach files, server settings or other sessions. The app role is the
// database owner, so a READ ONLY transaction alone does not stop any of these.
const FORBIDDEN_FUNCTIONS = /\b(?:query_to_xml\w*|table_to_xml\w*|cursor_to_xml\w*|schema_to_xml\w*|database_to_xml\w*|pg_read_file|pg_read_binary_file|pg_ls_\w+|pg_stat_file|lo_\w+|dblink\w*|current_setting|set_config|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_sleep\w*|pg_advisory\w*|pg_notify)\s*\(/i;

// Set-returning functions a plan may scan; anything else in a Function Scan is refused.
const ALLOWED_FUNCTION_SCANS = new Set([
  'generate_series', 'unnest', 'jsonb_array_elements', 'jsonb_array_elements_text',
  'jsonb_each', 'jsonb_each_text', 'json_array_elements', 'json_each',
  'regexp_split_to_table', 'string_to_table', 'regexp_matches',
]);

const FORBIDDEN_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|COPY|EXECUTE|SET\s+(?!LOCAL\s+statement_timeout|TRANSACTION))\b/i;

export class AnalyzeDataTool extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [{
      name: 'analyze_data',
      annotations: { title: 'Аналітичний SQL-запит (read-only)', readOnlyHint: true },
      description: `Виконання read-only SQL-запитів для аналітики: GROUP BY, COUNT, агрегати, JOIN.

Використовуйте коли потрібні агреговані дані, які search_ tools не повертають:
- "Скільки справ по ст. 130 КУпАП за 2024 з поділом по місяцях?"
- "Топ-10 суддів за кількістю вироків у кримінальних справах"
- "Середня кількість справ на суддю у Київському окружному адмінсуді"

Обмеження безопасності:
- Тільки SELECT (INSERT/UPDATE/DELETE/DROP заборонені)
- Таймаут 30 секунд
- Максимум 500 рядків у відповіді
- Дозволені тільки таблиці відкритих даних та ЄДРСР

Доступні таблиці (основні):
- edrsr_documents (82M: doc_id, cause_num, judge, court_code, justice_kind, judgment_code, category_code, adjudication_date)
- edrsr_courts (court_code, name, instance_code)
- edrsr_justice_kinds (justice_kind, name)
- edrsr_judgment_forms (judgment_code, name)
- opendata_* (всі реєстри відкритих даних)
- judges_current (dossier_number, full_name, court_name, gender)
- vrp_decisions, vkks_* (ВРП/ВККС)`,
      inputSchema: {
        type: 'object',
        properties: {
          sql: {
            type: 'string',
            description: 'SQL-запит (тільки SELECT). Обов\'язково додайте LIMIT (макс. 500).',
          },
        },
        required: ['sql'],
      },
    }];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    if (name !== 'analyze_data') return null;

    const sql = (args.sql || '').trim();
    if (!sql) return this.wrapError('sql є обов\'язковим параметром');

    const validation = this.validateQuery(sql);
    if (validation) return this.wrapError(validation);

    const client = await this.db.connect?.() ?? this.db;
    const shouldRelease = typeof this.db.connect === 'function';

    try {
      if (shouldRelease) {
        await client.query('BEGIN TRANSACTION READ ONLY');
        await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      }

      // The regex above is a fast first pass; the plan is the authority. It names every
      // relation the query will read, however it was written: quoted ("users"),
      // comma-joined (FROM a, users), schema-qualified, inside CTEs or subqueries.
      const planError = await this.checkPlan(client, sql);
      if (planError) {
        if (shouldRelease) await client.query('ROLLBACK').catch(() => {});
        return this.wrapError(planError);
      }

      const result = await client.query(sql);

      if (shouldRelease) {
        await client.query('COMMIT');
      }

      const rows = result.rows.slice(0, MAX_ROWS);

      logger.info('[AnalyzeDataTool] query executed', {
        rows_returned: rows.length,
        total_rows: result.rowCount,
      });

      return this.wrapResponse({
        rows_returned: rows.length,
        total_rows: result.rowCount,
        has_more: result.rowCount > MAX_ROWS,
        columns: result.fields?.map((f: any) => f.name) || [],
        results: rows,
      });
    } catch (err: any) {
      if (shouldRelease) {
        await client.query('ROLLBACK').catch(() => {});
      }

      if (err.message?.includes('statement timeout')) {
        return this.wrapError('Запит перевищив ліміт часу (30с). Спростіть запит або додайте WHERE/LIMIT.');
      }
      if (err.message?.includes('read-only transaction')) {
        return this.wrapError('Заборонено: тільки SELECT-запити дозволені.');
      }

      logger.error('[AnalyzeDataTool] query failed', { error: err.message, sql: sql.slice(0, 200) });
      return this.wrapError(`Помилка SQL: ${err.message}`);
    } finally {
      if (shouldRelease && typeof client.release === 'function') {
        client.release();
      }
    }
  }

  private validateQuery(sql: string): string | null {
    const normalized = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

    if (!normalized.trim().toUpperCase().startsWith('SELECT')) {
      return 'Дозволені тільки SELECT-запити.';
    }

    if (FORBIDDEN_FUNCTIONS.test(normalized)) {
      return 'Запит використовує заборонену функцію.';
    }

    if (FORBIDDEN_KEYWORDS.test(normalized)) {
      return 'Запит містить заборонені операції (INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE).';
    }

    // One statement only: the driver runs every statement in a multi-statement string,
    // and only the first would have been checked.
    if (normalized.trim().replace(/;\s*$/, '').includes(';')) {
      return 'Дозволено лише один SQL-оператор.';
    }

    if (!/\bLIMIT\b/i.test(normalized)) {
      return 'Запит повинен містити LIMIT (максимум 500).';
    }

    const limitMatch = normalized.match(/\bLIMIT\s+(\d+)/i);
    if (limitMatch && Number(limitMatch[1]) > MAX_ROWS) {
      return `LIMIT не може перевищувати ${MAX_ROWS}.`;
    }

    const referencedTables = this.extractTableNames(normalized);
    const forbidden = referencedTables.filter(t => !ALLOWED_TABLES.has(t));
    if (forbidden.length > 0) {
      return `Таблиці не дозволені: ${forbidden.join(', ')}. Дозволені: edrsr_*, opendata_*, judges*, vrp_*, vkks_*, nbu_banks, uk_legislation*.`;
    }

    return null;
  }

  /** Every relation and function scan in the plan must be allowed. Fails closed. */
  private async checkPlan(client: any, sql: string): Promise<string | null> {
    let plan: any;
    try {
      const r = await client.query(`EXPLAIN (FORMAT JSON, VERBOSE) ${sql.trim().replace(/;\s*$/, '')}`);
      const raw = r.rows?.[0]?.['QUERY PLAN'];
      plan = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (err: any) {
      return `Помилка SQL: ${err.message}`;
    }
    const root = Array.isArray(plan) ? plan[0]?.Plan : undefined;
    if (!root) return 'Не вдалося перевірити план запиту.';
    const bad = new Set<string>();
    const walk = (n: any) => {
      if (!n || typeof n !== 'object') return;
      const rel = n['Relation Name'];
      if (rel) {
        const schema = n['Schema'];
        if ((schema && schema !== 'public') || !ALLOWED_TABLES.has(String(rel))) bad.add(schema ? `${schema}.${rel}` : rel);
      }
      if (n['Node Type'] === 'Function Scan' && !ALLOWED_FUNCTION_SCANS.has(String(n['Function Name']))) {
        bad.add(`${n['Function Name'] ?? 'function'}()`);
      }
      for (const c of n.Plans || []) walk(c);
    };
    walk(root);
    return bad.size ? `Таблиці не дозволені: ${[...bad].join(', ')}.` : null;
  }

  private extractTableNames(sql: string): string[] {
    const tables: string[] = [];
    const fromJoinRegex = /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi;
    let match;
    while ((match = fromJoinRegex.exec(sql)) !== null) {
      const tableName = match[1].toLowerCase();
      if (!['select', 'where', 'and', 'or', 'on', 'as', 'left', 'right', 'inner', 'outer', 'cross', 'full', 'natural'].includes(tableName)) {
        tables.push(tableName);
      }
    }
    return [...new Set(tables)];
  }
}
