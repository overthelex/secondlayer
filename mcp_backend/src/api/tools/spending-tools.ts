/**
 * Spending Tools — MCP tools for public spending data (spending.gov.ua)
 *
 * 1 tool:
 * - search_public_spending — Акти, додаткові угоди, пеня, контракти (12.6M+ записів)
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';

const TABLE_MAP: Record<string, string> = {
  acts: 'spending_acts',
  addendums: 'spending_addendums',
  peny: 'spending_peny',
  contracts: 'spending_contracts',
};

// `parent_id` links a child document back to its contract, so the contracts table itself does
// not have the column. Selecting it unconditionally made EVERY contracts query throw
// (`column "parent_id" does not exist`), and the per-table catch turned that into a silent
// zero — contracts were invisible even under the default doc_type 'all'.
const TABLES_WITHOUT_PARENT_ID = new Set(['spending_contracts']);

const DOC_TYPE_LABELS: Record<string, string> = {
  acts: 'Акт виконаних робіт',
  addendums: 'Додаткова угода',
  peny: 'Пеня / штраф',
  contracts: 'Договір',
};

export class SpendingTools extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'search_public_spending',
        annotations: { title: 'Публічні витрати (spending.gov.ua)', readOnlyHint: true, openWorldHint: true },
        description: `Пошук у реєстрі публічних витрат (spending.gov.ua)

12.6M+ записів: акти виконаних робіт (9.45M), додаткові угоди (2.11M), пеня (40K), договори (2.8K).
Пошук за ЄДРПОУ розпорядника, назвою контрагента, сумою, датою, типом документа.`,
        inputSchema: {
          type: 'object',
          properties: {
            edrpou: { type: 'string', description: 'ЄДРПОУ розпорядника бюджетних коштів' },
            contractor_name: { type: 'string', description: 'Назва контрагента (часткове входження)' },
            contractor_edrpou: { type: 'string', description: 'ЄДРПОУ контрагента' },
            date_from: { type: 'string', description: 'Дата підписання від (YYYY-MM-DD)' },
            date_to: { type: 'string', description: 'Дата підписання до (YYYY-MM-DD)' },
            min_amount: { type: 'number', description: 'Мін. сума (копійки)' },
            max_amount: { type: 'number', description: 'Макс. сума (копійки)' },
            doc_type: {
              type: 'string',
              enum: ['acts', 'addendums', 'peny', 'contracts', 'all'],
              description: 'Тип документа (acts/addendums/peny/contracts/all). За замовчуванням: all',
            },
            limit: { type: 'number', default: 50, maximum: 100, description: 'Макс. результатів' },
          },
        },
      },
    ];
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    switch (name) {
      case 'search_public_spending': return this.searchPublicSpending(args);
      default: return null;
    }
  }

  private async searchPublicSpending(args: Record<string, unknown>): Promise<ToolResult> {
    const {
      edrpou, contractor_name, contractor_edrpou,
      date_from, date_to, min_amount, max_amount,
      doc_type = 'all', limit = 50,
    } = args as any;

    const conditions: string[] = [];
    const values: any[] = [];
    let pi = 1;

    if (edrpou) {
      conditions.push(`edrpou = $${pi}`);
      values.push(edrpou);
      pi++;
    }
    if (date_from) {
      conditions.push(`sign_date >= $${pi}`);
      values.push(date_from);
      pi++;
    }
    if (date_to) {
      conditions.push(`sign_date <= $${pi}`);
      values.push(date_to);
      pi++;
    }
    if (min_amount != null) {
      conditions.push(`amount >= $${pi}`);
      values.push(min_amount);
      pi++;
    }
    if (max_amount != null) {
      conditions.push(`amount <= $${pi}`);
      values.push(max_amount);
      pi++;
    }

    // JSONB contractor search
    let contractorCondition = '';
    if (contractor_name) {
      contractorCondition = `EXISTS (SELECT 1 FROM jsonb_array_elements(contractors) AS c WHERE c->>'name' ILIKE $${pi})`;
      conditions.push(contractorCondition);
      values.push(`%${contractor_name}%`);
      pi++;
    }
    if (contractor_edrpou) {
      conditions.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(contractors) AS c WHERE c->>'code' = $${pi})`);
      values.push(contractor_edrpou);
      pi++;
    }

    if (conditions.length === 0) {
      return this.wrapResponse('Вкажіть хоча б один параметр: edrpou, contractor_name, contractor_edrpou, date_from/date_to, або min_amount/max_amount');
    }

    const maxRows = Math.min(Number(limit) || 50, 100);
    const whereClause = conditions.join(' AND ');

    // Determine which tables to query
    const tables = doc_type === 'all'
      ? Object.entries(TABLE_MAP)
      : TABLE_MAP[doc_type]
        ? [[doc_type, TABLE_MAP[doc_type]]]
        : Object.entries(TABLE_MAP);

    const allResults: any[] = [];
    const tableErrors: Array<{ table: string; error: string }> = [];
    const QUERY_TIMEOUT_MS = 15000;

    for (const [dtype, tableName] of tables) {
      try {
        const parentIdCol = TABLES_WITHOUT_PARENT_ID.has(tableName)
          ? 'NULL::bigint AS parent_id'
          : 'parent_id';
        const sql = `SELECT id, edrpou, document_number, document_date, sign_date,
          amount, currency, pdv_include, pdv_amount,
          contractors, ${parentIdCol}
          FROM ${tableName}
          WHERE ${whereClause}
          ORDER BY sign_date DESC NULLS LAST
          LIMIT ${maxRows}`;

        const result = await Promise.race([
          this.db.query(sql, values),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout: запит до ${tableName} перевищив ${QUERY_TIMEOUT_MS / 1000}с`)), QUERY_TIMEOUT_MS)
          ),
        ]);
        for (const row of result.rows) {
          allResults.push({
            ...row,
            doc_type: dtype,
            doc_type_label: DOC_TYPE_LABELS[dtype] || dtype,
            amount_uah: row.amount ? (Number(row.amount) / 100).toFixed(2) : null,
          });
        }
      } catch (err: any) {
        // Record it as well as logging: swallowing this silently is what let a broken
        // contracts query read as "no results" for as long as it did.
        tableErrors.push({ table: tableName, error: String(err.message).slice(0, 200) });
        logger.warn(`[SpendingTools] Error querying ${tableName}`, { error: err.message });
      }
    }

    // Sort merged results by sign_date DESC and trim
    allResults.sort((a, b) => {
      const da = a.sign_date ? new Date(a.sign_date).getTime() : 0;
      const db = b.sign_date ? new Date(b.sign_date).getTime() : 0;
      return db - da;
    });

    const trimmed = allResults.slice(0, maxRows);

    if (trimmed.length === 0) {
      return this.wrapResponse(JSON.stringify({
        query: { edrpou, contractor_name, contractor_edrpou, date_from, date_to, min_amount, max_amount, doc_type },
        total: 0,
        returned: 0,
        results: [],
        ...(tableErrors.length ? { failed_tables: tableErrors } : {}),
        note: tableErrors.length
          ? `Запит до ${tableErrors.length} таблиць(і) завершився помилкою — це НЕ означає, що даних немає. Див. failed_tables.`
          : 'Результатів не знайдено. Можливо, запит був надто широким і перевищив timeout. Спробуйте уточнити параметри (вказати edrpou, звузити діапазон дат).',
      }, null, 2));
    }

    return this.wrapResponse(JSON.stringify({
      query: { edrpou, contractor_name, contractor_edrpou, date_from, date_to, min_amount, max_amount, doc_type },
      total: allResults.length,
      returned: trimmed.length,
      ...(tableErrors.length ? { failed_tables: tableErrors, partial: true } : {}),
      results: trimmed,
    }, null, 2));
  }
}
