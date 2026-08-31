/**
 * Regression test for the /sse tools/list curated whitelist.
 *
 * Bug: MCPSSEServer.handleToolsList used a blind `allTools.slice(0, 15)`, which kept only
 * the first 15 tools by registration order and silently dropped the court-decision / ЄДРСР
 * tools (registered later in tool-services.ts). ChatGPT — which connects via /sse — therefore
 * could not look up court cases by number.
 *
 * Fix: advertise the curated V2_TOOL_NAMES whitelist instead. This test drives the real
 * constructor (ToolRegistry-based) and asserts the court tools survive and non-curated tools
 * are filtered out.
 */

import { MCPSSEServer } from '../mcp-sse-server.js';
import { V2_TOOL_NAMES } from '../curated-mcp-tools.js';
import { MockSSEResponse } from '../../__tests__/helpers/mock-sse-response.js';
import { Request } from 'express';

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

describe('MCPSSEServer tools/list curated whitelist', () => {
  // A registry that returns a realistic mix: curated tools (incl. court) registered AFTER
  // several non-curated ones — exactly the ordering that the old slice(0,15) mishandled.
  const localToolDefs = [
    // non-curated, registered first (these used to crowd out the court tools)
    { name: 'parse_document', description: 'x', inputSchema: { type: 'object', properties: {} } },
    { name: 'summarize_document', description: 'x', inputSchema: { type: 'object', properties: {} } },
    { name: 'risk_scoring', description: 'x', inputSchema: { type: 'object', properties: {} } },
    { name: 'classify_intent', description: 'x', inputSchema: { type: 'object', properties: {} } },
    // curated legislation
    { name: 'search_legislation', description: 'x', inputSchema: { type: 'object', properties: {} } },
    // curated court / ЄДРСР (registered late — the ones the bug dropped)
    { name: 'search_court_decisions', description: 'x', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_case_documents_chain', description: 'x', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_court_decision', description: 'x', inputSchema: { type: 'object', properties: {} } },
  ];

  const fakeRegistry = {
    getLocalToolDefinitions: jest.fn().mockReturnValue(localToolDefs),
    getAllToolDefinitions: jest.fn().mockResolvedValue(localToolDefs),
    executeTool: jest.fn(),
  };
  const fakeCostTracker = {
    createTrackingRecord: jest.fn(),
    completeTrackingRecord: jest.fn(),
  };

  let server: MCPSSEServer;
  let mockRes: MockSSEResponse;
  let mockReq: Partial<Request>;

  beforeEach(() => {
    jest.clearAllMocks();
    server = new MCPSSEServer(fakeRegistry as any, fakeCostTracker as any);
    mockRes = new MockSSEResponse();
    mockReq = {
      ip: '127.0.0.1',
      headers: { 'user-agent': 'ChatGPT/1.0' },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      on: jest.fn(),
    };
  });

  it('advertises curated court tools and filters out non-curated tools', async () => {
    await server.handleSSEConnection(mockReq as Request, mockRes as any, 'user-123');
    await new Promise((r) => setTimeout(r, 50));

    const events = mockRes.parseEvents();
    const listEvent = events.find((e) => e.data?.result?.tools);
    expect(listEvent).toBeDefined();

    const names: string[] = listEvent!.data.result.tools.map((t: any) => t.name);

    // Court tools (the ones the slice(0,15) bug dropped) must now be present.
    expect(names).toContain('search_court_decisions');
    expect(names).toContain('get_case_documents_chain');
    expect(names).toContain('get_court_decision');

    // Non-curated tools must be filtered out.
    expect(names).not.toContain('parse_document');
    expect(names).not.toContain('summarize_document');
    expect(names).not.toContain('risk_scoring');

    // Every advertised tool is in the curated whitelist.
    for (const n of names) {
      expect(V2_TOOL_NAMES.has(n)).toBe(true);
    }

    // tools/list must read the merged list, not the local-only one: /sse can execute
    // rada_*/openreyestr_* (handleToolCall proxies via toolRegistry.executeTool) but used to
    // advertise only local tools, hiding 23 of the 54 curated tools from a ChatGPT client.
    expect(fakeRegistry.getAllToolDefinitions).toHaveBeenCalled();
  });
});
