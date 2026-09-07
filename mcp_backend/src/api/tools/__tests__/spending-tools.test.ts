/**
 * search_public_spending — contractor_name lookup.
 *
 * The contractor filter is an EXISTS over jsonb_array_elements(contractors), which no
 * index can serve: every call seq-scanned and sorted the whole table, and
 * spending_addendums (2.1M rows) blew the 15s budget and came back as a failed table.
 * The fix pairs that EXISTS with an index-backed prefilter on the exact expression
 * indexed by idx_spending_*_contractor_names_trgm (migrations 211-214).
 *
 * These tests pin the two halves that must not drift: the prefilter expression has to
 * match the index expression character for character, or Postgres silently goes back to
 * the seq scan; and the query has to run under a server-side statement_timeout, so an
 * abandoned call stops burning a connection.
 */

import { SpendingTools } from '../spending-tools.js';

jest.mock('../../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

/** The expression indexed by migrations 211-214. Kept verbatim on purpose. */
const INDEXED_EXPRESSION = "jsonb_path_query_array(contractors, '$[*].name')::text";

type Call = { sql: string; values: any[] };

function makeDb(behaviour: (sql: string, values: any[]) => Promise<any>) {
  const calls: Call[] = [];
  const sessionSettings: string[] = [];
  const db = {
    calls,
    sessionSettings,
    async transaction(cb: (client: any) => Promise<any>) {
      const client = {
        async query(sql: string, values?: any[]) {
          if (values === undefined) {
            sessionSettings.push(sql);
            return { rows: [] };
          }
          calls.push({ sql, values });
          return behaviour(sql, values);
        },
      };
      return cb(client);
    },
  };
  return db;
}

const parse = (r: any) => JSON.parse(r.content[0].text);

describe('search_public_spending contractor_name', () => {
  it('pairs the trigram prefilter with the exact EXISTS, both on one parameter', async () => {
    const db = makeDb(async () => ({ rows: [] }));
    const tools = new SpendingTools(db);

    await tools.executeTool('search_public_spending', {
      contractor_name: 'Нова Пошта',
      doc_type: 'addendums',
      limit: 2,
    });

    expect(db.calls).toHaveLength(1);
    const { sql, values } = db.calls[0];

    // Index-backed half — must be the expression the GIN index was built on.
    expect(sql).toContain(`${INDEXED_EXPRESSION} ILIKE $1`);
    // Exact half — per-element semantics are still what decides the result.
    expect(sql).toContain("EXISTS (SELECT 1 FROM jsonb_array_elements(contractors) AS c WHERE c->>'name' ILIKE $1)");
    // One parameter feeds both halves, so they can never disagree.
    expect(values).toEqual(['%Нова Пошта%']);
    expect(sql).not.toContain('$2');
  });

  it('runs under a server-side statement_timeout', async () => {
    const db = makeDb(async () => ({ rows: [] }));
    const tools = new SpendingTools(db);

    await tools.executeTool('search_public_spending', { contractor_name: 'Нова Пошта', doc_type: 'acts' });

    expect(db.sessionSettings).toEqual(['SET LOCAL statement_timeout = 15000']);
  });

  it('reports a server-side cancellation as a timeout, not as raw pg text', async () => {
    const db = makeDb(async () => {
      throw new Error('canceling statement due to statement timeout');
    });
    const tools = new SpendingTools(db);

    const out = parse(await tools.executeTool('search_public_spending', {
      contractor_name: 'Нова Пошта',
      doc_type: 'addendums',
    }));

    expect(out.failed_tables).toEqual([
      { table: 'spending_addendums', error: 'Timeout: запит до spending_addendums перевищив 15с' },
    ]);
    // A failed table is not an empty registry, and the note has to say so.
    expect(out.total).toBe(0);
    expect(out.note).toContain('НЕ означає, що даних немає');
  });

  it('keeps a table that answered when another one fails', async () => {
    const db = makeDb(async (sql) => {
      if (sql.includes('spending_addendums')) throw new Error('canceling statement due to statement timeout');
      if (sql.includes('spending_acts')) {
        return { rows: [{ id: '1', edrpou: '42633385', sign_date: '2026-03-23', amount: '195', contractors: [] }] };
      }
      return { rows: [] };
    });
    const tools = new SpendingTools(db);

    const out = parse(await tools.executeTool('search_public_spending', { contractor_name: 'Нова Пошта' }));

    expect(out.returned).toBe(1);
    expect(out.partial).toBe(true);
    expect(out.failed_tables.map((t: any) => t.table)).toEqual(['spending_addendums']);
  });
});
