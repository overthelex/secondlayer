/**
 * Integration tests for ChCitationTools against a real PostgreSQL.
 *
 * A mocked db.query cannot validate the SQL (joins over ch_case_citations /
 * ch_decision_index / ch_court_decisions, deterministic docket disambiguation).
 * Set CH_TEST_DATABASE_URL to run; skipped otherwise.
 *
 *   CH_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/ch_tools_test npx jest ch-citation-tools.pg
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { ChCitationTools } from '../ch-citation-tools';

jest.mock('../../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const DSN = process.env.CH_TEST_DATABASE_URL;
const describeIfPg = DSN ? describe : describe.skip;

function parse(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

if (DSN) {
  const dbName = new URL(DSN).pathname.split('/').pop() || '';
  if (!dbName.includes('test')) {
    throw new Error('CH_TEST_DATABASE_URL must point to a database whose name contains "test"');
  }
}

describeIfPg('ChCitationTools (real PostgreSQL)', () => {
  let client: Client;
  let tools: ChCitationTools;

  // The cited target: a published BGE. Known source quirk: the same BGE can exist
  // under several ECLIs — seeded below as TARGET + TARGET_DUP sharing one docket.
  const TARGET = 'ECLI:CH:CH_BGE:CH_BGE_007_BGE-125-V-351_1999';
  const TARGET_DUP = 'ECLI:CH:CH_BGE:CH_BGE_999_BGE-125-V-351_1999';
  const CITING_RECENT = 'ECLI:CH:BGER:2024:8C.1.2024';
  const CITING_OLD = 'ECLI:CH:BGER:2005:1C.9.2005';
  const UNCITED = 'ECLI:CH:BGER:2020:2C.2.2020';
  const NOT_LOADED = 'ECLI:CH:BGER:2022:3C.3.2022';

  async function seedDecision(
    ecli: string, docId: string, spider: string, courtCode: string,
    date: string | null, docket: string | null, stage = 'loaded'
  ): Promise<void> {
    await client.query(
      `INSERT INTO ch_court_decisions
         (ecli, doc_id, spider, court_code, court_name, decision_date, docket_number,
          languages, full_text, stage)
       VALUES ($1, $2, $3, $4, $4, $5, $6, ARRAY['de'], 'text', $7)`,
      [ecli, docId, spider, courtCode, date, docket, stage]
    );
  }

  async function seedEdge(
    fromEcli: string, toRaw: string, kind: string, toEcli: string | null,
    fromDateSql: string, fromCourt: string | null
  ): Promise<void> {
    await client.query(
      `INSERT INTO ch_case_citations
         (from_ecli, to_raw, cite_kind, to_ecli, resolved, match_method, from_date, from_court)
       VALUES ($1, $2, $3, $4, $5, $6, ${fromDateSql}, $7)`,
      [fromEcli, toRaw, kind, toEcli, toEcli != null,
       toEcli != null ? 'docket_exact' : 'unresolved', fromCourt]
    );
  }

  beforeAll(async () => {
    client = new Client({ connectionString: DSN });
    await client.connect();

    const migrations = join(__dirname, '../../../migrations');
    for (const file of ['134_ch_court_decisions.sql', '135_ch_legislation.sql',
                        '196_ch_court_pipeline.sql', '197_ch_legislation_corpus.sql',
                        '198_ch_as_bbl.sql', '199_ch_citation_graph.sql',
                        '201_ch_cantonal_legislation.sql',
                        '207_ch_decision_index.sql']) {
      await client.query(readFileSync(join(migrations, file), 'utf-8'));
    }

    tools = new ChCitationTools({
      query: (text: string, params?: any[]) => client.query(text, params),
    } as any);
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  beforeEach(async () => {
    await client.query(
      'TRUNCATE ch_court_decisions, ch_case_citations, ch_legislation_citations, ch_decision_index, ch_act CASCADE');

    await seedDecision(TARGET, 'CH_BGE_007_BGE-125-V-351', 'CH_BGE', 'CH_BGE_007',
      '1999-10-01', 'BGE 125 V 351');
    await seedDecision(TARGET_DUP, 'CH_BGE_999_BGE-125-V-351', 'CH_BGE', 'CH_BGE_999',
      '1999-10-01', 'BGE 125 V 351');
    await seedDecision(CITING_RECENT, 'CH_BGer_2024_8C_1', 'CH_BGer', 'CH_BGer_008',
      '2024-05-01', '8C_1/2024');
    await seedDecision(CITING_OLD, 'CH_BGer_2005_1C_9', 'CH_BGer', 'CH_BGer_001',
      '2005-02-01', '1C_9/2005');
    await seedDecision(UNCITED, 'CH_BGer_2020_2C_2', 'CH_BGer', 'CH_BGer_002',
      '2020-01-15', '2C_2/2020');
    await seedDecision(NOT_LOADED, 'CH_BGer_2022_3C_3', 'CH_BGer', 'CH_BGer_003',
      '2022-01-15', '3C_3/2022', 'extracted');

    // CITING_RECENT cites the BGE (resolved, dated within the last year via a
    // relative date, so the recency rules are stable as wall-clock time moves)
    // and one case outside the corpus (unresolved).
    await seedEdge(CITING_RECENT, 'BGE 125 V 351', 'bge', TARGET,
      `CURRENT_DATE - INTERVAL '100 days'`, 'CH_BGer_008');
    await seedEdge(CITING_RECENT, '5A_999/2001', 'docket', null,
      `CURRENT_DATE - INTERVAL '100 days'`, 'CH_BGer_008');
    // CITING_OLD cites the BGE long ago.
    await seedEdge(CITING_OLD, 'BGE 125 V 351', 'bge', TARGET,
      `DATE '2005-02-01'`, 'CH_BGer_001');

    // The inbound aggregate decision_index_stage would have built.
    await client.query(
      `INSERT INTO ch_decision_index
         (ecli, cited_by_count, citing_courts, first_citing_date, last_citing_date)
       VALUES ($1, 2, 2, DATE '2005-02-01', CURRENT_DATE - INTERVAL '100 days')`,
      [TARGET]
    );

    // Legislation citations for the graph's legislation summary.
    await client.query(
      `INSERT INTO ch_act (act_id, eli_work_uri, sr_number, title_de, abbreviation, jurisdiction, stage)
       VALUES (1, 'https://x/act/1', '220', 'Obligationenrecht', 'OR', 'CH', 'discovered'),
              (2, 'https://x/act/2', '210', 'Zivilgesetzbuch', 'ZGB', 'CH', 'discovered')`);
    await client.query(
      `INSERT INTO ch_legislation_citations (from_ecli, abbr_raw, article, act_id, resolved, match_method)
       VALUES ($1, 'OR', '336', 1, true, 'edition_at_date'),
              ($1, 'OR', '337', 1, true, 'edition_at_date'),
              ($1, 'ZGB', '8', 2, true, 'edition_at_date'),
              ($1, 'LPA-VD', '75', NULL, false, 'unresolved_abbr')`,
      [CITING_RECENT]
    );
  });

  // ─── ch_get_citation_graph ─────────────────────────────────────────

  describe('ch_get_citation_graph', () => {
    it('returns outbound case citations with target metadata, resolved first', async () => {
      const res = parse(await (tools as any).executeTool('ch_get_citation_graph',
        { ecli: CITING_RECENT }));

      expect(res.ecli).toBe(CITING_RECENT);
      expect(res.outbound.total).toBe(2);
      expect(res.outbound.resolved_count).toBe(1);
      expect(res.outbound.unresolved_count).toBe(1);
      const first = res.outbound.cases[0];
      expect(first.to_ecli).toBe(TARGET);
      expect(first.resolved).toBe(true);
      expect(first.docket_number).toBe('BGE 125 V 351');
      expect(first.decision_date).toBe('1999-10-01');
      expect(res.outbound.unresolved_refs).toEqual(['5A_999/2001']);
    });

    it('returns the inbound aggregate and recent citing decisions', async () => {
      const res = parse(await (tools as any).executeTool('ch_get_citation_graph',
        { ecli: TARGET }));

      expect(res.inbound.cited_by_count).toBe(2);
      expect(res.inbound.citing_courts).toBe(2);
      expect(res.inbound.first_citing_date).toBe('2005-02-01');
      expect(res.inbound.recent.length).toBe(2);
      // Most recent citer first.
      expect(res.inbound.recent[0].from_ecli).toBe(CITING_RECENT);
      expect(res.inbound.recent[1].from_ecli).toBe(CITING_OLD);
    });

    it('reports zero inbound for a decision nothing cites', async () => {
      const res = parse(await (tools as any).executeTool('ch_get_citation_graph',
        { ecli: UNCITED }));

      expect(res.inbound.cited_by_count).toBe(0);
      expect(res.inbound.recent).toEqual([]);
    });

    it('summarises cited legislation by act with an honest unresolved tail', async () => {
      const res = parse(await (tools as any).executeTool('ch_get_citation_graph',
        { ecli: CITING_RECENT }));

      expect(res.legislation.total_citations).toBe(4);
      expect(res.legislation.total_acts).toBe(2);
      expect(res.legislation.top_acts[0]).toMatchObject(
        { sr_number: '220', abbreviation: 'OR', citations_count: 2 });
      expect(res.legislation.unresolved_count).toBe(1);
      expect(res.legislation.next).toMatchObject({ tool: 'ch_get_decision_legislation' });
    });

    it('distinguishes not_loaded from not_found', async () => {
      const notLoaded = parse(await (tools as any).executeTool('ch_get_citation_graph',
        { ecli: NOT_LOADED }));
      expect(notLoaded.error).toBe('not_loaded');
      expect(notLoaded.stage).toBe('extracted');

      const notFound = parse(await (tools as any).executeTool('ch_get_citation_graph',
        { ecli: 'ECLI:CH:NO:SUCH' }));
      expect(notFound.error).toBe('not_found');
    });

    it('requires ecli', async () => {
      const res = await (tools as any).executeTool('ch_get_citation_graph', {});
      expect(res.content[0].text).toContain('ecli');
    });
  });

  // ─── ch_check_precedent_status ─────────────────────────────────────

  describe('ch_check_precedent_status', () => {
    it('reports an actively cited precedent by ecli', async () => {
      const res = parse(await (tools as any).executeTool('ch_check_precedent_status',
        { ecli: TARGET }));

      expect(res.status).toBe('actively_cited');
      expect(res.cited_by_count).toBe(2);
      expect(res.citing_courts).toBe(2);
      expect(res.citations_last_5_years).toBe(1);
      expect(res.recent_citings[0].from_ecli).toBe(CITING_RECENT);
    });

    it('reports uncited for a loaded decision nothing cites', async () => {
      const res = parse(await (tools as any).executeTool('ch_check_precedent_status',
        { ecli: UNCITED }));
      expect(res.status).toBe('uncited');
      expect(res.cited_by_count).toBe(0);
    });

    it('resolves a BGE reference deterministically and reports duplicates as variants', async () => {
      const res = parse(await (tools as any).executeTool('ch_check_precedent_status',
        { reference: 'BGE 125 V 351' }));

      // Two CH_BGE rows share the docket; the pick must be deterministic (ORDER BY
      // ecli within the preferred spider) and both must be visible.
      expect(res.ecli).toBe(TARGET);
      expect(res.variants.sort()).toEqual([TARGET, TARGET_DUP].sort());
      expect(res.status).toBe('actively_cited');
    });

    it('accepts the French/Italian citation form (ATF/DTF) for the same BGE', async () => {
      const res = parse(await (tools as any).executeTool('ch_check_precedent_status',
        { reference: 'ATF 125 V 351' }));
      expect(res.ecli).toBe(TARGET);
    });

    it('resolves a docket reference to the citing decision itself', async () => {
      const res = parse(await (tools as any).executeTool('ch_check_precedent_status',
        { reference: '8C_1/2024' }));
      expect(res.ecli).toBe(CITING_RECENT);
      expect(res.status).toBe('uncited');
    });

    it('reports not_in_corpus for a reference nothing matches', async () => {
      const res = parse(await (tools as any).executeTool('ch_check_precedent_status',
        { reference: 'BGE 1 I 1' }));
      expect(res.status).toBe('not_in_corpus');
      expect(res.reference).toBe('BGE 1 I 1');
    });

    it('keeps the not_loaded distinction for an ecli still in the pipeline', async () => {
      const res = parse(await (tools as any).executeTool('ch_check_precedent_status',
        { ecli: NOT_LOADED }));
      expect(res.error).toBe('not_loaded');
    });

    it('requires ecli or reference', async () => {
      const res = await (tools as any).executeTool('ch_check_precedent_status', {});
      expect(res.content[0].text).toMatch(/ecli|reference/);
    });
  });
});
