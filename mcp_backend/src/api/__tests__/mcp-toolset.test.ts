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
