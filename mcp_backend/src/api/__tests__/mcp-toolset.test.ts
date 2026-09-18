/**
 * Deployment toolset gate (MCP_TOOLSET) — mcp-toolset.ts.
 *
 * lawrider.ch runs the same backend as legal.org.ua but must serve ONLY the Swiss
 * corpus over MCP (user decision, 2026-09-01). The gate narrows both tools/list and
 * tools/call on every transport; an unknown value fails closed so a compose typo
 * cannot quietly re-expose the UA/UK tools on the Swiss endpoint.
 */

import { isToolInToolset, filterToolsByToolset } from '../mcp-toolset.js';
import { MCPSSEServer } from '../mcp-sse-server.js';
import { MockSSEResponse } from '../../__tests__/helpers/mock-sse-response.js';
import { Request } from 'express';

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const ORIGINAL_TOOLSET = process.env.MCP_TOOLSET;

afterEach(() => {
  if (ORIGINAL_TOOLSET === undefined) delete process.env.MCP_TOOLSET;
  else process.env.MCP_TOOLSET = ORIGINAL_TOOLSET;
});

describe('isToolInToolset', () => {
  it('serves everything when MCP_TOOLSET is unset or "all"', () => {
    delete process.env.MCP_TOOLSET;
    expect(isToolInToolset('search_registry')).toBe(true);
    expect(isToolInToolset('ch_get_act_text')).toBe(true);

    process.env.MCP_TOOLSET = 'all';
    expect(isToolInToolset('search_registry')).toBe(true);
  });

  it('serves only ch_* when MCP_TOOLSET=ch', () => {
    process.env.MCP_TOOLSET = 'ch';
    expect(isToolInToolset('ch_get_act_text')).toBe(true);
    expect(isToolInToolset('ch_search_court_decisions')).toBe(true);
    // UA and UK entry points must be hidden on the Swiss deployment.
    expect(isToolInToolset('search_registry')).toBe(false);
    expect(isToolInToolset('search_court_decisions')).toBe(false);
    expect(isToolInToolset('get_npa_act')).toBe(false);
    // Prefix means prefix: a name merely containing 'ch_' does not qualify.
    expect(isToolInToolset('search_ch_things')).toBe(false);
  });

  it('serves everything except ch_* when MCP_TOOLSET=ua', () => {
    process.env.MCP_TOOLSET = 'ua';
    expect(isToolInToolset('search_court_decisions')).toBe(true);
    expect(isToolInToolset('get_npa_act')).toBe(true);
    expect(isToolInToolset('openreyestr_search_entities')).toBe(true);
    expect(isToolInToolset('rada_search_parliament_bills')).toBe(true);
    // The Swiss corpus lives on lawrider; ch_* tables here are empty.
    expect(isToolInToolset('ch_get_act_text')).toBe(false);
    expect(isToolInToolset('ch_semantic_search')).toBe(false);
    // Complement of the same prefix rule: 'ch_' mid-name is still a UA tool.
    expect(isToolInToolset('search_ch_things')).toBe(true);
  });

  it('ua and ch partition the registry between the two deployments', () => {
    const names = [
      'search_court_decisions',
      'get_npa_act',
      'openreyestr_search_entities',
      'ch_get_act_text',
      'ch_semantic_search',
    ];
    process.env.MCP_TOOLSET = 'ua';
    const ua = names.filter(isToolInToolset);
    process.env.MCP_TOOLSET = 'ch';
    const ch = names.filter(isToolInToolset);

    expect(ua.filter((n) => ch.includes(n))).toEqual([]);
    expect([...ua, ...ch].sort()).toEqual([...names].sort());
  });

  it('serves only uk_* when MCP_TOOLSET=uk', () => {
    process.env.MCP_TOOLSET = 'uk';
    expect(isToolInToolset('uk_get_provision')).toBe(true);
    expect(isToolInToolset('uk_search_legislation')).toBe(true);
    expect(isToolInToolset('ch_get_act_text')).toBe(false);
    expect(isToolInToolset('search_registry')).toBe(false);
    // Prefix means prefix here too.
    expect(isToolInToolset('search_uk_things')).toBe(false);
  });

  it('accepts a comma-separated list, which is what lawrider.ch needs', () => {
    // The Swiss box holds both corpora: 238,926 UK acts alongside the CH ones, and the
    // UK half is OGL-licensed and ungated. 'ch' alone hid all of it (LEXAI-2057).
    process.env.MCP_TOOLSET = 'ch,uk';
    expect(isToolInToolset('ch_get_act_text')).toBe(true);
    expect(isToolInToolset('uk_get_act_as_at')).toBe(true);
    expect(isToolInToolset('search_court_decisions')).toBe(false);
    expect(isToolInToolset('rada_search_parliament_bills')).toBe(false);
  });

  it('excludes uk_* from the ua complement, because UK lives on lawrider', () => {
    process.env.MCP_TOOLSET = 'ua';
    expect(isToolInToolset('uk_get_provision')).toBe(false);
    expect(isToolInToolset('search_court_decisions')).toBe(true);
  });

  it('honours the good members of a list that also contains a typo', () => {
    // Dropping every tool because someone left a stray comma or misspelled one value
    // would be its own outage; only a value with NO recognisable member fails closed.
    process.env.MCP_TOOLSET = 'ch,uk,';
    expect(isToolInToolset('ch_get_act_text')).toBe(true);
    expect(isToolInToolset('uk_get_act')).toBe(true);

    process.env.MCP_TOOLSET = 'ch,kh';
    expect(isToolInToolset('ch_get_act_text')).toBe(true);
    expect(isToolInToolset('uk_get_act')).toBe(false);
  });

  it('keeps every tool lawrider.ch serves today when uk is added to the list', () => {
    // Captured from the live GET /mcp discovery on the GCP box on 2026-09-18, before the
    // toolset change. Adding 'uk' must be purely additive: if any of these twenty stops
    // being advertised, the Swiss product loses a tool on the next deploy.
    const LIVE_ON_LAWRIDER = [
      'ch_check_precedent_status', 'ch_get_act_article', 'ch_get_act_history',
      'ch_get_act_text', 'ch_get_article_purpose', 'ch_get_citation_graph',
      'ch_get_commentary', 'ch_get_company', 'ch_get_court_decision',
      'ch_get_decision_legislation', 'ch_get_echr_case', 'ch_get_material',
      'ch_search_commentary', 'ch_search_companies', 'ch_search_court_decisions',
      'ch_search_echr', 'ch_search_legislation', 'ch_search_materials',
      'ch_semantic_search', 'ch_verify_citations',
    ];

    process.env.MCP_TOOLSET = 'ch,uk';
    expect(LIVE_ON_LAWRIDER.filter((n) => !isToolInToolset(n))).toEqual([]);

    // And the old value keeps behaving exactly as it did, so a rollback is safe.
    process.env.MCP_TOOLSET = 'ch';
    expect(LIVE_ON_LAWRIDER.filter((n) => !isToolInToolset(n))).toEqual([]);
    expect(isToolInToolset('uk_get_act')).toBe(false);
  });

  it('lets NOTHING Ukrainian through on the Swiss box, family by family', () => {
    // The GCP box must serve no UA tool at all (user, 2026-09-18). 90 of the 115 tool
    // names declared under api/tools are neither ch_ nor uk_, and they are not one
    // family: alongside the obvious search_*/get_*/rada_*/openreyestr_* there are
    // ab_*, osint-ish check_*, import control (start_import, cancel_import), a bare
    // `query`, and per-jurisdiction one-offs like india_* and spain_*. One representative
    // per naming family, so a new prefix cannot sneak past the ch_/uk_ rule unnoticed.
    const UA_FAMILIES = [
      'ab_create_experiment', 'analyze_case_pattern', 'build_legal_decision',
      'bulk_ingest_court_decisions', 'calculate_monetary_claims', 'cancel_import',
      'check_domain_reputation', 'compare_practice_pro_contra', 'count_cases_by_party',
      'edrsr_court_decisions_by_court', 'extract_document_sections',
      'find_similar_fact_pattern_cases', 'format_answer_pack', 'get_case_documents_chain',
      'india_court_stats', 'list_import_sources', 'load_full_texts', 'nextcloud_share',
      'query', 'search_amcu_practice', 'spain_aepd_get_resolution', 'start_import',
      'vectorize_edrsr_results', 'workflow_memory_ingest',
      'rada_search_parliament_bills', 'openreyestr_search_entities',
    ];

    process.env.MCP_TOOLSET = 'ch,uk';
    expect(UA_FAMILIES.filter(isToolInToolset)).toEqual([]);

    // The same must hold for the value the box runs today, so the guarantee does not
    // depend on which of the two is deployed at any moment.
    process.env.MCP_TOOLSET = 'ch';
    expect(UA_FAMILIES.filter(isToolInToolset)).toEqual([]);
  });

  it('fails closed on an unknown toolset value', () => {
    process.env.MCP_TOOLSET = 'hc';
    expect(isToolInToolset('ch_get_act_text')).toBe(false);
    expect(isToolInToolset('search_registry')).toBe(false);
  });

  it('filterToolsByToolset keeps only toolset members', () => {
    process.env.MCP_TOOLSET = 'ch';
    const filtered = filterToolsByToolset([
      { name: 'ch_get_act_text' },
      { name: 'search_registry' },
    ]);
    expect(filtered.map((t) => t.name)).toEqual(['ch_get_act_text']);
  });
});

describe('MCPSSEServer under MCP_TOOLSET=ch', () => {
  // Curated names on both sides of the gate: the Swiss tools must survive, the UA ones
  // must disappear from tools/list AND be rejected by tools/call.
  const localToolDefs = [
    { name: 'ch_search_court_decisions', description: 'x', inputSchema: { type: 'object', properties: {} } },
    { name: 'ch_get_act_text', description: 'x', inputSchema: { type: 'object', properties: {} } },
    { name: 'search_court_decisions', description: 'x', inputSchema: { type: 'object', properties: {} } },
    { name: 'search_registry', description: 'x', inputSchema: { type: 'object', properties: {} } },
  ];

  const fakeRegistry = {
    getLocalToolDefinitions: jest.fn().mockReturnValue(localToolDefs),
    getAllToolDefinitions: jest.fn().mockResolvedValue(localToolDefs),
    executeTool: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
  };
  const fakeCostTracker = {
    createTrackingRecord: jest.fn(),
    completeTrackingRecord: jest.fn(),
  };

  function requestFor(body: Record<string, unknown>): Partial<Request> {
    return { ip: '127.0.0.1', headers: { 'user-agent': 'test/1.0' }, body, on: jest.fn() };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MCP_TOOLSET = 'ch';
  });

  it('tools/list advertises only ch_* tools', async () => {
    const server = new MCPSSEServer(fakeRegistry as any, fakeCostTracker as any);
    const res = new MockSSEResponse();
    await server.handleSSEConnection(
      requestFor({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as Request,
      res as any,
      'user-123'
    );
    await new Promise((r) => setTimeout(r, 50));

    const listEvent = res.parseEvents().find((e) => e.data?.result?.tools);
    expect(listEvent).toBeDefined();
    const names: string[] = listEvent!.data.result.tools.map((t: any) => t.name);
    expect(names).toEqual(['ch_search_court_decisions', 'ch_get_act_text']);
  });

  it('tools/call rejects a non-ch tool without executing it', async () => {
    const server = new MCPSSEServer(fakeRegistry as any, fakeCostTracker as any);
    const res = new MockSSEResponse();
    await server.handleSSEConnection(
      requestFor({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'search_registry', arguments: { query: 'x' } },
      }) as Request,
      res as any,
      'user-123'
    );
    await new Promise((r) => setTimeout(r, 50));

    const errEvent = res.parseEvents().find((e) => e.data?.error);
    expect(errEvent).toBeDefined();
    expect(errEvent!.data.error.message).toContain('not available');
    expect(fakeRegistry.executeTool).not.toHaveBeenCalled();
  });

  it('with the deployed ch,uk value, tools/call still refuses a UA tool and still runs a ch_ one', async () => {
    // The list-level assertions above are about advertising. This is the one that matters
    // for a box that must not serve UA at all: a caller who already knows the name gets
    // refused before the registry is touched, under the value the GCP box will run.
    process.env.MCP_TOOLSET = 'ch,uk';
    const server = new MCPSSEServer(fakeRegistry as any, fakeCostTracker as any);

    const denied = new MockSSEResponse();
    await server.handleSSEConnection(
      requestFor({
        jsonrpc: '2.0', id: 10, method: 'tools/call',
        params: { name: 'search_court_decisions', arguments: { query: 'x' } },
      }) as Request,
      denied as any,
      'user-123'
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(denied.parseEvents().find((e) => e.data?.error)).toBeDefined();
    expect(fakeRegistry.executeTool).not.toHaveBeenCalled();

    const allowed = new MockSSEResponse();
    await server.handleSSEConnection(
      requestFor({
        jsonrpc: '2.0', id: 11, method: 'tools/call',
        params: { name: 'ch_get_act_text', arguments: { as_of: '2020-01-01' } },
      }) as Request,
      allowed as any,
      'user-123'
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(fakeRegistry.executeTool).toHaveBeenCalledWith(
      'ch_get_act_text', { as_of: '2020-01-01' }
    );
  });

  it('tools/call still executes a ch_* tool', async () => {
    const server = new MCPSSEServer(fakeRegistry as any, fakeCostTracker as any);
    const res = new MockSSEResponse();
    await server.handleSSEConnection(
      requestFor({
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'ch_get_act_text', arguments: { sr_number: '220', as_of: '2019-11-06' } },
      }) as Request,
      res as any,
      'user-123'
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(fakeRegistry.executeTool).toHaveBeenCalledWith(
      'ch_get_act_text',
      expect.objectContaining({ sr_number: '220' })
    );
  });
});
