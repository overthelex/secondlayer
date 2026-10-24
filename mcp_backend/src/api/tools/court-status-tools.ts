/**
 * Court Case Status Tools
 *
 * 1 tool:
 * - search_court_case_status — пошук статусів судових справ (1.25M записів)
 *
 * Note: search_court_schedule was merged into search_court_hearing_schedule (court-session-tools.ts)
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';

/**
 * Index expression for case-number lookups (LEXAI-2104). MUST stay byte-identical to the
 * expression in migration 230_court_case_status_number_norm.sql, otherwise the planner
 * cannot use idx_case_status_case_norm and every lookup seq-scans 1.25M rows.
 * Whitespace is stripped (the source has numbers like " 201/14253/25" and "16- ц") and the
 * case folded ("-Ц" and "-ц" are the same proceeding suffix).
 */
export const CASE_NUMBER_NORM_SQL = `lower(regexp_replace(case_number, '\\s+', '', 'g'))`;

/** Same normalisation as CASE_NUMBER_NORM_SQL, applied to user input. */
export function normalizeCaseNumber(raw: string): string {
  return String(raw || '').replace(/\s+/g, '').toLowerCase();
}

/**
 * A case number "has a suffix" when it ends in -<letters> after the last digit group:
 * 522/9583/16-ц, 761/1/19-к, 9901/5/20-а. Anything ending in a digit (522/9583/16,
 * old-style 2-123/2010) has none.
 */
export function hasProceedingSuffix(normalized: string): boolean {
  return /\d-[^\d/-]+$/u.test(normalized);
}

/** Escape LIKE metacharacters so a user-typed % or _ is matched literally. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

/**
 * Build the WHERE fragment for a case number. Users rarely type the proceeding suffix,
 * and the registry stores the same case both bare (522/9583/16) and suffixed
 * (522/9583/16-ц), so a bare number also matches "<number>-<anything>". The "-" anchor
 * keeps 522/9583/16 from matching 522/9583/161. Both branches are served by the
 * text_pattern_ops expression index (equality + left-anchored LIKE).
 */
export function buildCaseNumberCondition(
  raw: string,
  paramIndex: number,
): { sql: string; values: string[] } {
  const norm = normalizeCaseNumber(raw);
  if (hasProceedingSuffix(norm)) {
    return { sql: `${CASE_NUMBER_NORM_SQL} = $${paramIndex}`, values: [norm] };
  }
  return {
    sql: `(${CASE_NUMBER_NORM_SQL} = $${paramIndex} OR ${CASE_NUMBER_NORM_SQL} LIKE $${paramIndex + 1})`,
    values: [norm, `${escapeLike(norm)}-%`],
  };
}

export class CourtStatusTools extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'search_court_case_status',
        annotations: { title: 'Статус судової справи', readOnlyHint: true },
        description: `Пошук статусів судових справ (Касаційний суд та інші)

💰 Примерная стоимость: $0.001-$0.005 USD
Пошук за номером справи, суддею, учасниками або описом. 1.25M записів (2000-2025).`,
        inputSchema: {
          type: 'object',
          properties: {
            case_number: {
              type: 'string',
              description: 'Номер справи (наприклад, 352/923/16-ц)',
            },
            judge: {
              type: 'string',
              description: 'Прізвище судді',
            },
            description: {
              type: 'string',
              description: 'Ключові слова з опису справи',
            },
            court_name: {
              type: 'string',
              description: 'Назва суду',
            },
            limit: {
              type: 'number',
              default: 50,
              maximum: 100,
              description: 'Максимальна кількість результатів',
            },
          },
        },
      },
    ];
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    switch (name) {
      case 'search_court_case_status':
        return this.searchCaseStatus(args);
      default:
        return null;
    }
  }

  private async searchCaseStatus(args: Record<string, unknown>): Promise<ToolResult> {
    const { case_number, judge, description, court_name, limit = 50 } = args as any;

    const conditions: string[] = [];
    const values: any[] = [];
    let pi = 1;

    if (case_number) {
      const cond = buildCaseNumberCondition(String(case_number), pi);
      conditions.push(cond.sql);
      values.push(...cond.values);
      pi += cond.values.length;
    }
    if (judge) {
      conditions.push(`(judge ILIKE $${pi} OR judges ILIKE $${pi})`);
      values.push(`%${judge}%`);
      pi++;
    }
    if (description) {
      conditions.push(`description ILIKE $${pi}`);
      values.push(`%${description}%`);
      pi++;
    }
    if (court_name) {
      conditions.push(`court_name ILIKE $${pi}`);
      values.push(`%${court_name}%`);
      pi++;
    }

    if (conditions.length === 0) {
      return this.wrapResponse('Вкажіть номер справи, суддю або опис для пошуку');
    }

    values.push(Math.min(Number(limit) || 50, 100));

    // stage_date is DD.MM.YYYY text, so ordering the raw string sorted by day of month
    // (30.06.2021 above 13.07.2022); order by YYYYMMDD so the latest step is first. String
    // rearrangement rather than to_date(), which raises on an impossible date like 31.02.
    // stage_name is a single space in 1.03M of 1.25M rows: the cassation courts' feed leaves
    // it blank and carries the procedural step in cause_result instead (every row has one of
    // the two). Surface the step as stage_name, trimmed, and turn blank strings into null.
    const sql = `SELECT court_name, case_number, NULLIF(btrim(case_proc), '') AS case_proc,
        NULLIF(btrim(case_type), '') AS case_type, registration_date, judge, NULLIF(btrim(judges), '') AS judges,
        stage_date,
        COALESCE(NULLIF(btrim(stage_name), ''), NULLIF(btrim(cause_result), '')) AS stage_name,
        NULLIF(btrim(cause_result), '') AS cause_result,
        NULLIF(btrim(description), '') AS description
      FROM opendata_court_case_status
      WHERE ${conditions.join(' AND ')}
      ORDER BY CASE WHEN stage_date ~ '^\\d{2}\\.\\d{2}\\.\\d{4}$'
        THEN substr(stage_date, 7, 4) || substr(stage_date, 4, 2) || substr(stage_date, 1, 2) END DESC NULLS LAST
      LIMIT $${pi}`;

    try {
      const result = await this.db.query(sql, values);
      if (result.rows.length === 0) {
        return this.wrapResponse('Статусів судових справ не знайдено за вашим запитом');
      }
      return this.wrapResponse(JSON.stringify(result.rows, null, 2));
    } catch (error: any) {
      logger.error('search_court_case_status error', { error: error.message });
      return this.wrapError(`Помилка пошуку: ${error.message}`);
    }
  }

}
