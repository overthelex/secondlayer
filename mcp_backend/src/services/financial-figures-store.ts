/**
 * Writes to financial_figures (migration 278), shared by the backfill and the ДПС 2020
 * importer. One statement per batch: rows go in as a single jsonb parameter.
 */
import { dedupeFigureRows, FinancialFigureRow } from '../api/tools/financial-statement-figures.js';

export interface Queryable {
  query(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

const COLUMNS = [
  'edrpou', 'year', 'period', 'form', 'source', 'name', 'kved', 'filed_on', 'doc_stan', 'report_date',
  'period_name', 'cur', 'prev', 'assets', 'equity', 'liabilities', 'revenue', 'net_profit', 'source_ref', 'source_id',
] as const;

const RECORD_TYPES = `edrpou text, year smallint, period smallint, form text, source text, name text, kved text,
  filed_on date, doc_stan smallint, report_date date, period_name text, cur jsonb, prev jsonb, assets numeric,
  equity numeric, liabilities numeric, revenue numeric, net_profit numeric, source_ref text, source_id bigint`;

const UPDATABLE = COLUMNS.filter((c) => !['edrpou', 'year', 'period', 'form', 'source'].includes(c));

/**
 * Upsert rows; within the batch and against the table the later filing wins
 * (filed_on, then doc_stan, then source_id; see newerFiling). Returns rows written.
 */
export const UPSERT_SQL = `
  INSERT INTO financial_figures (${COLUMNS.join(', ')})
  SELECT ${COLUMNS.join(', ')}
  FROM jsonb_to_recordset($1::jsonb) AS r(${RECORD_TYPES})
  ON CONFLICT (edrpou, year, period, form, source) DO UPDATE SET
    ${UPDATABLE.map((c) => `${c} = EXCLUDED.${c}`).join(',\n    ')},
    updated_at = NOW()
  WHERE (COALESCE(EXCLUDED.filed_on, DATE '1900-01-01'), COALESCE(EXCLUDED.doc_stan, 0), COALESCE(EXCLUDED.source_id, 0))
     >= (COALESCE(financial_figures.filed_on, DATE '1900-01-01'), COALESCE(financial_figures.doc_stan, 0), COALESCE(financial_figures.source_id, 0))`;

export async function upsertFigureRows(db: Queryable, rows: FinancialFigureRow[]): Promise<number> {
  const unique = dedupeFigureRows(rows);
  if (!unique.length) return 0;
  const res = await db.query(UPSERT_SQL, [JSON.stringify(unique)]);
  return res.rowCount ?? 0;
}

/** Statement timeout as a SET-able literal; rejects anything but digits and a unit. */
export function statementTimeoutLiteral(v: string): string {
  const s = String(v).trim();
  if (!/^\d+(ms|s|min)?$/.test(s)) throw new Error(`invalid statement timeout: ${v}`);
  return s;
}
