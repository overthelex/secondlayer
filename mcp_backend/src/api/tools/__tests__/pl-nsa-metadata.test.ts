/**
 * NSA/WSA metadata in pl_search_court_decisions / pl_get_court_decision: the filters authority,
 * case_symbol, judge, final (pl_decision_meta, migration 273), input validation and the read-time
 * fields of a decision. The db is mocked.
 */

jest.mock('../../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { PlLegalTools, authoritySql, withMetadata } from '../pl-legal-tools.js';

/** A db whose transaction() hands the tool a client answering queries in order. */
function mockDb(answers: Array<(sql: string, params: unknown[]) => any[]> = []) {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    transaction: async (fn: any) => fn({
      query: async (sql: string, params: unknown[] = []) => {
        if (/^SET LOCAL/.test(sql)) return { rows: [] };
        seen.push({ sql, params });
        const next = answers.shift();
        return { rows: next ? next(sql, params) : [] };
      },
    }),
  };
  return { db, seen };
}

const parse = (r: any) => {
  const t = r.content[0].text;
  try { return JSON.parse(t); } catch { return t; }
};
const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/[()]/g, '').trim();

describe('NSA metadata filters', () => {
  it('lists the new filters in the schema with Ukrainian descriptions', () => {
    const def = new PlLegalTools({}).getToolDefinitions().find((d) => d.name === 'pl_search_court_decisions')!;
    const props = (def.inputSchema as any).properties;
    for (const key of ['authority', 'case_symbol', 'judge', 'final']) {
      expect(props[key]).toBeDefined();
      expect(/[Ѐ-ӿ]/.test(props[key].description)).toBe(true);
    }
    expect(props.final.type).toBe('boolean');
  });

  it('filters through pl_decision_meta on the columns the migration indexes', async () => {
    const { db, seen } = mockDb();
    await new PlLegalTools(db).executeTool('pl_search_court_decisions', {
      authority: '  Dyrektor   Izby Administracji Skarbowej ', case_symbol: '6110', judge: 'Dauter, Bogusław', final: false,
    });
    expect(seen).toHaveLength(1);
    const { sql, params } = seen[0];
    expect(norm(sql)).toContain(norm(`id IN (SELECT m.id FROM pl_decision_meta m WHERE m.authority ILIKE $1
      AND m.symbols @> ARRAY[$2::text] AND m.judges ILIKE $3 AND m.judges ILIKE $4 AND m.final = $5)`));
    expect(sql).toContain('decision_date <= CURRENT_DATE');
    expect(params).toEqual(['%Dyrektor%Izby%Administracji%Skarbowej%', '6110', '%Dauter%', '%Bogusław%', false]);

    const migration = norm(readFileSync(join(__dirname, '../../../migrations/273_pl_nsa_metadata_idx.sql'), 'utf8'));
    expect(migration).toContain('CREATE MATERIALIZED VIEW IF NOT EXISTS pl_decision_meta');
    for (const idx of ['authority gin_trgm_ops', 'USING gin symbols', 'judges gin_trgm_ops', 'final, decision_date']) {
      expect(migration).toContain(idx);
    }
  });

  it('adds no subquery without metadata filters', async () => {
    const { db, seen } = mockDb([() => [{ word: 'vat', forms: [] }], () => []]);
    await new PlLegalTools(db).executeTool('pl_search_court_decisions', { query: 'vat' });
    expect(seen[1].sql).not.toContain('pl_decision_meta');
    expect(seen[1].sql).toContain(authoritySql());
  });

  it('escapes LIKE wildcards and combines with a full-text query', async () => {
    const { db, seen } = mockDb([() => [{ word: 'vat', forms: [] }], () => []]);
    await new PlLegalTools(db).executeTool('pl_search_court_decisions', { query: 'vat', authority: '100%_Organ', final: true });
    const { sql, params } = seen[1];
    expect(params).toContain('%100\\%\\_Organ%');
    expect(params).toContain(true);
    expect(sql).toContain('@@');
  });

  it('rejects bad values without querying', async () => {
    for (const args of [
      {},
      { final: true },
      { case_symbol: '61' },
      { case_symbol: '61a0' },
      { authority: 'SK' },
      { judge: 'Li' },
      { query: 'vat', final: 'yes' },
    ]) {
      const { db, seen } = mockDb();
      const r = await new PlLegalTools(db).executeTool('pl_search_court_decisions', args);
      expect(typeof parse(r)).toBe('string');
      expect(seen).toHaveLength(0);
    }
  });

  it('folds metadata fields into search rows and drops the empty ones', async () => {
    const { db } = mockDb([() => [
      {
        id: 'hf-pl-nsa-1', judge: null, keywords: [], judges_list: ['Bogusław Dauter'], keywords_list: ['VAT'],
        challenged_authority: 'Dyrektor Izby Administracji Skarbowej', case_type: ['6110 Podatek od towarów i usług'],
        final: true, snippet: '<p>x</p>',
      },
      { id: 'saos-2', judge: 'A B', keywords: [], judges_list: null, keywords_list: [], challenged_authority: null, case_type: null, final: null, snippet: '' },
    ]]);
    const out = parse(await new PlLegalTools(db).executeTool('pl_search_court_decisions', { authority: 'Dyrektor' }));
    expect(out.results[0]).toMatchObject({
      judges: ['Bogusław Dauter'], keywords: ['VAT'], challenged_authority: 'Dyrektor Izby Administracji Skarbowej',
      case_type: ['6110 Podatek od towarów i usług'], final: true, snippet: 'x',
    });
    expect(out.results[1]).toEqual({ id: 'saos-2', judge: 'A B', snippet: '' });
  });
});

describe('pl_get_court_decision metadata', () => {
  it('returns the NSA fields that are present', async () => {
    const { db, seen } = mockDb([() => [{
      id: 'hf-pl-nsa-15500-data_14', keywords: null, judges_list: ['Mikosz Ryszard', 'Karpińska Ewa'], keywords_list: ['Finanse publiczne'],
      challenged_authority: null, case_type: ['611 Podatki'], final: true, presiding_judge: 'Mikosz Ryszard',
      judge_rapporteur: 'Mikosz Ryszard', related_cases: [{ case_number: 'I SA/Gl 659/09', date: '2010-02-01', type: 'Wyrok WSA' }],
      thesis: 'Teza', outcome: null, dissenting_opinion: null, full_text: 'abc',
    }]]);
    const out = parse(await new PlLegalTools(db).executeTool('pl_get_court_decision', { id: 'hf-pl-nsa-15500-data_14' }));
    expect(seen[0].sql).toContain('related_docket_numbers');
    expect(out).toMatchObject({
      judges: ['Mikosz Ryszard', 'Karpińska Ewa'], keywords: ['Finanse publiczne'], case_type: ['611 Podatki'], final: true,
      presiding_judge: 'Mikosz Ryszard', thesis: 'Teza', related_cases: [{ case_number: 'I SA/Gl 659/09' }],
    });
    for (const key of ['challenged_authority', 'outcome', 'dissenting_opinion', 'judges_list', 'keywords_list']) {
      expect(out).not.toHaveProperty(key);
    }
  });

  it('withMetadata keeps a false finality', () => {
    expect(withMetadata({ id: 'x', final: false, judges_list: [], keywords_list: null })).toEqual({ id: 'x', final: false });
  });
});
