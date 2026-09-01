/**
 * Tests for ChVerificationTools — ch_verify_citations, the deterministic
 * self-check an external MCP agent runs over its own draft answer before
 * presenting it (lawrider has no chat of its own; verification is a tool).
 *
 * Extraction helpers are pure and tested without a database. The verdicts
 * are SQL over ch_court_decisions / ch_case_citations / ch_legislation_citations /
 * ch_decision_index, so those tests need a real PostgreSQL — a mocked db
 * cannot validate the joins. Set CH_TEST_DATABASE_URL to run them.
 *
 *   CH_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/ch_tools_test npx jest ch-verification-tools.pg
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import {
  ChVerificationTools,
  extractChCaseReferences,
  extractChNormClaims,
  extractChQuotedClaims,
} from '../ch-verification-tools';

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

// ─── extraction (pure, no DB) ────────────────────────────────────────

describe('extractChCaseReferences', () => {
  it('normalises the reporter forms (BGE/ATF/DTF) to one canonical reference', () => {
    const refs = extractChCaseReferences(
      'Gemäss BGE 125 V 351 und ATF 142 III 102; vgl. auch DTF 130 V 343.');
    expect(refs.map(r => r.normalized)).toEqual(
      ['BGE 125 V 351', 'BGE 142 III 102', 'BGE 130 V 343']);
    expect(refs.every(r => r.kind === 'bge')).toBe(true);
  });

  it('extracts dockets and ECLIs, deduplicated, preserving the raw form', () => {
    const refs = extractChCaseReferences(
      'Справа 4A_22/2017 (ECLI:CH:BGER:2017:4A.22.2017); див. також 4A_22/2017 і 8C_1/2024.');
    expect(refs.map(r => r.normalized)).toEqual(
      ['4A_22/2017', 'ECLI:CH:BGER:2017:4A.22.2017', '8C_1/2024']);
    expect(refs.map(r => r.kind)).toEqual(['docket', 'ecli', 'docket']);
  });

  it('does not extract Ukrainian case numbers as CH dockets', () => {
    expect(extractChCaseReferences('у справі № 826/11557/18 та 200/1185/21')).toEqual([]);
  });
});

describe('extractChQuotedClaims', () => {
  it('attributes a long quote to the nearest preceding CH reference', () => {
    const claims = extractChQuotedClaims(
      'У BGE 125 V 351 суд зазначив: «Die Beweiswürdigung ist frei, aber nicht willkürlich vorzunehmen».');
    expect(claims).toHaveLength(1);
    expect(claims[0].reference).toBe('BGE 125 V 351');
    expect(claims[0].quote).toContain('Beweiswürdigung');
  });

  it('attributes by the nearest OCCURRENCE, not the first mention of a reference', () => {
    // Live repro (2026-09-01): the quote sat right after a repeat mention of
    // BGE 125 V 351, but dedup had kept only the FIRST occurrence — far away —
    // so the nearest surviving reference was a different (invented) BGE from
    // the previous sentence, and the quote was attributed to it.
    const claims = extractChQuotedClaims(
      'Прецедент BGE 125 V 351 підтверджує це; див. також BGE 999 V 999.\n' +
      'У BGE 125 V 351 суд зазначив: «Die Beweiswürdigung ist frei, aber nicht willkürlich vorzunehmen».');
    expect(claims).toHaveLength(1);
    expect(claims[0].reference).toBe('BGE 125 V 351');
  });

  it('ignores short quotes and quotes with no CH reference nearby', () => {
    expect(extractChQuotedClaims('Суд сказав «ні» у BGE 125 V 351.')).toEqual([]);
    expect(extractChQuotedClaims(
      '«Ein ganz langes Zitat ohne jede Referenz, das niemandem zugeschrieben ist».')).toEqual([]);
  });
});

describe('extractChNormClaims', () => {
  it('pairs an Art. N ABBR citation with a case reference in the same sentence', () => {
    const claims = extractChNormClaims(
      'У справі 8C_1/2024 суд застосував Art. 336 Abs. 1 OR. Окремо, Art. 8 ZGB регулює тягар доказування.');
    expect(claims).toEqual([
      { reference: '8C_1/2024', article: '336', abbr: 'OR' },
    ]);
  });

  it('supports the fr/it particle forms (art. N al. N CO)', () => {
    const claims = extractChNormClaims(
      "Dans l'arrêt 4A_22/2017, le tribunal a appliqué l'art. 336 al. 1 CO.");
    expect(claims).toEqual([
      { reference: '4A_22/2017', article: '336', abbr: 'CO' },
    ]);
  });

  it('extracts nothing from a doctrinal citation with no case in the sentence', () => {
    expect(extractChNormClaims('Art. 336 OR захищає від зловживання правом на звільнення.')).toEqual([]);
  });
});

// ─── verdicts (real PostgreSQL) ──────────────────────────────────────

describeIfPg('ChVerificationTools (real PostgreSQL)', () => {
  let client: Client;
  let tools: ChVerificationTools;

  const TARGET = 'ECLI:CH:CH_BGE:CH_BGE_007_BGE-125-V-351_1999';
  const CITING = 'ECLI:CH:BGER:2024:8C.1.2024';
  const BARE = 'ECLI:CH:BGER:2020:2C.2.2020';   // loaded, no citation edges at all
  const QUOTE_SENTENCE =
    'Die Beweiswürdigung des kantonalen Gerichts ist frei, aber nicht willkürlich vorzunehmen.';

  beforeAll(async () => {
    client = new Client({ connectionString: DSN });
    await client.connect();

    const migrations = join(__dirname, '../../../migrations');
    for (const file of ['134_ch_court_decisions.sql', '135_ch_legislation.sql',
                        '196_ch_court_pipeline.sql', '197_ch_legislation_corpus.sql',
                        '198_ch_as_bbl.sql', '199_ch_citation_graph.sql',
                        '201_ch_cantonal_legislation.sql', '207_ch_decision_index.sql']) {
      await client.query(readFileSync(join(migrations, file), 'utf-8'));
    }

    tools = new ChVerificationTools({
      query: (text: string, params?: any[]) => client.query(text, params),
    } as any);
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  beforeEach(async () => {
    await client.query(
      'TRUNCATE ch_court_decisions, ch_case_citations, ch_legislation_citations, ch_decision_index, ch_act CASCADE');

    await client.query(
      `INSERT INTO ch_court_decisions (ecli, doc_id, spider, court_code, decision_date, docket_number, languages, full_text, stage)
       VALUES ($1, 'd1', 'CH_BGE', 'CH_BGE_007', '1999-10-01', 'BGE 125 V 351', ARRAY['de'], $2, 'loaded'),
              ($3, 'd2', 'CH_BGer', 'CH_BGer_008', '2024-05-01', '8C_1/2024', ARRAY['de'], 'Erwägungen des Gerichts.', 'loaded'),
              ($4, 'd3', 'CH_BGer', 'CH_BGer_002', '2020-01-15', '2C_2/2020', ARRAY['de'], 'Kurzer Text.', 'loaded')`,
      [TARGET, `Aus den Erwägungen: ${QUOTE_SENTENCE} Weitere Ausführungen folgen.`, CITING, BARE]
    );

    await client.query(
      `INSERT INTO ch_decision_index (ecli, cited_by_count, citing_courts, first_citing_date, last_citing_date)
       VALUES ($1, 2, 2, DATE '2005-02-01', CURRENT_DATE - INTERVAL '100 days')`,
      [TARGET]
    );

    await client.query(
      `INSERT INTO ch_act (act_id, eli_work_uri, sr_number, title_de, abbreviation, jurisdiction, stage)
       VALUES (1, 'https://x/act/1', '220', 'Obligationenrecht', 'OR', 'CH', 'discovered')`);
    await client.query(
      `INSERT INTO ch_legislation_citations (from_ecli, abbr_raw, article, act_id, resolved, match_method)
       VALUES ($1, 'OR', '336', 1, true, 'edition_at_date'),
              ($1, 'OR', '337', 1, true, 'edition_at_date'),
              ($1, 'LPA-VD', '75', NULL, false, 'unresolved_abbr')`,
      [CITING]
    );
  });

  async function verify(text: string): Promise<any> {
    return parse(await (tools as any).executeTool('ch_verify_citations', { text }));
  }

  it('confirms existing citations and flags an invented one', async () => {
    const res = await verify(
      'Позиція викладена у BGE 125 V 351 та у справі 8C_1/2024; див. також BGE 1 I 1.');

    const byRef = Object.fromEntries(res.references.map((r: any) => [r.reference, r]));
    expect(byRef['BGE 125 V 351'].exists).toBe(true);
    expect(byRef['BGE 125 V 351'].ecli).toBe(TARGET);
    expect(byRef['8C_1/2024'].exists).toBe(true);
    expect(byRef['BGE 1 I 1'].exists).toBe(false);
    expect(res.verdicts.citation_validity).toBe('warning');
    expect(res.invalid_references).toEqual(['BGE 1 I 1']);
  });

  it('reports precedent status for the cited decisions', async () => {
    const res = await verify('Провідний прецедент — BGE 125 V 351.');

    const ref = res.references[0];
    expect(ref.status).toBe('actively_cited');
    expect(ref.cited_by_count).toBe(2);
    expect(res.verdicts.precedent_status).toBe('ok');
  });

  it('grounds a verbatim quote and flags an invented one', async () => {
    const grounded = await verify(
      `У BGE 125 V 351 суд зазначив: «${QUOTE_SENTENCE.slice(0, -1)}».`);
    expect(grounded.quotes[0].grounded).toBe(true);
    expect(grounded.verdicts.quote_grounding).toBe('pass');

    const invented = await verify(
      'У BGE 125 V 351 суд зазначив: «Die Kündigung ist in jedem Fall missbräuchlich und nichtig».');
    expect(invented.quotes[0].grounded).toBe(false);
    expect(invented.verdicts.quote_grounding).toBe('warning');
  });

  it('supports a norm the decision cites and flags article- and act-level mismatches', async () => {
    const ok = await verify('У справі 8C_1/2024 суд застосував Art. 336 OR.');
    expect(ok.norm_claims[0].supported).toBe(true);
    expect(ok.verdicts.norm_attribution).toBe('pass');

    const wrongArticle = await verify('У справі 8C_1/2024 суд застосував Art. 999 OR.');
    expect(wrongArticle.norm_claims[0].supported).toBe(false);
    expect(wrongArticle.norm_claims[0].reason).toBe('article_not_cited');

    const wrongAct = await verify('У справі 8C_1/2024 суд застосував Art. 8 ZGB.');
    expect(wrongAct.norm_claims[0].supported).toBe(false);
    expect(wrongAct.norm_claims[0].reason).toBe('act_not_cited');
  });

  it('treats a decision with no extracted edges as a coverage gap, never a mismatch', async () => {
    const res = await verify('У справі 2C_2/2020 суд застосував Art. 336 OR.');
    expect(res.norm_claims[0].supported).toBe(null);
    expect(res.norm_claims[0].reason).toBe('no_citation_data');
    expect(res.verdicts.norm_attribution).toBe('unknown');
  });

  it('handles an answer with no CH citations at all', async () => {
    const res = await verify('Загальні міркування без жодного посилання.');
    expect(res.references).toEqual([]);
    expect(res.verdicts.citation_validity).toBe('no_citations');
    expect(res.verdicts.quote_grounding).toBe('no_quotes');
    expect(res.verdicts.norm_attribution).toBe('no_claims');
  });

  it('requires text', async () => {
    const res = await (tools as any).executeTool('ch_verify_citations', {});
    expect(res.content[0].text).toContain('text');
  });
});
