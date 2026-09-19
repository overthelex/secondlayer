/**
 * Regression tests for search_public_spending.
 *
 * The bug these exist for: the SELECT listed `parent_id` for every table, but that column links
 * a child document back to its contract and so does not exist on spending_contracts. Every
 * contracts query threw, the per-table catch swallowed it, and the tool reported an empty result
 * with a note blaming a timeout — so contracts were invisible even under the default doc_type
 * 'all', while 368 rows matched the queried window on prod.
 */

import { SpendingTools } from '../tools/spending-tools.js';

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const parse = (r: any) => JSON.parse(r.content[0].text);

/**
 * A db double for SpendingTools.
 *
 * The tool runs each table query inside a transaction so it can `SET LOCAL
 * statement_timeout` — Postgres then cancels the query itself instead of the
 * handler merely walking away from it. A double with only `query` therefore
 * threw "this.db.transaction is not a function" on every call, the per-table
 * catch swallowed it, and three of these tests failed while the fourth passed
 * for the wrong reason: it asserts that a failing table is reported, and got a
 * failure — just not the SQL one it was written for.
 *
 * `calls` records the DATA queries only. The SET LOCAL is bookkeeping and
 * recording it would shift every index the assertions below rely on.
 */
function makeDb(onQuery: (sql: string, n: number) => Promise<any>) {
  const calls: string[] = [];
  let n = 0;
  const client = {
    query: (sql: string, _values?: any[]) => {
      if (/^\s*SET LOCAL/i.test(sql)) return Promise.resolve({ rows: [] });
      calls.push(sql);
      return onQuery(sql, ++n);
    },
  };
  return {
    calls,
    query: client.query,
    transaction: (fn: (c: any) => Promise<any>) => fn(client),
  };
}

describe('search_public_spending', () => {
  it('does not select parent_id from the contracts table', async () => {
    const db = makeDb(() => Promise.resolve({ rows: [] }));
    const tools = new SpendingTools(db);

    await tools.executeTool('search_public_spending', { doc_type: 'contracts', date_from: '2024-01-01' });

    const sql = db.calls[0];
    expect(sql).toContain('FROM spending_contracts');
    expect(sql).toContain('NULL::bigint AS parent_id');
    // the bare column would throw: `column "parent_id" does not exist`
    expect(sql).not.toMatch(/contractors,\s*parent_id/);
  });

  it('still selects the real parent_id for child-document tables', async () => {
    const db = makeDb(() => Promise.resolve({ rows: [] }));
    const tools = new SpendingTools(db);

    await tools.executeTool('search_public_spending', { doc_type: 'acts', date_from: '2024-01-01' });

    expect(db.calls[0]).toContain('FROM spending_acts');
    expect(db.calls[0]).toMatch(/contractors,\s*parent_id/);
    expect(db.calls[0]).not.toContain('NULL::bigint');
  });

  it('reports a failing table instead of passing it off as "no results"', async () => {
    const db = makeDb(() => Promise.reject(new Error('column "parent_id" does not exist')));
    const tools = new SpendingTools(db);

    const out = parse(await tools.executeTool('search_public_spending', { doc_type: 'contracts', date_from: '2024-01-01' }));

    expect(out.total).toBe(0);
    expect(out.failed_tables).toHaveLength(1);
    expect(out.failed_tables[0].table).toBe('spending_contracts');
    // the old note blamed a timeout and hid a hard SQL error
    expect(out.note).toContain('помилкою');
    expect(out.note).not.toContain('надто широким');
  });

  it('flags a partial result when one table of an "all" query fails', async () => {
    const db = makeDb((_sql, n) =>
      n === 1
        ? Promise.resolve({ rows: [{ id: 1, sign_date: '2025-01-01', amount: 100 }] })
        : Promise.reject(new Error('boom')));
    const tools = new SpendingTools(db);

    const out = parse(await tools.executeTool('search_public_spending', { date_from: '2024-01-01' }));

    expect(out.returned).toBe(1);
    expect(out.partial).toBe(true);
    expect(out.failed_tables.length).toBeGreaterThan(0);
  });
});
