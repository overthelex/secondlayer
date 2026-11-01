/**
 * LEXAI-2164: unknown tool arguments are rejected with a Ukrainian message listing the
 * valid ones, instead of being silently dropped.
 */

import { allowedArgNames, findUnknownArgs, checkToolArgs } from '../tool-args-validator.js';
import { ToolRegistry } from '../tool-registry.js';
import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';

const debtorsSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: "Ім'я/назва боржника або частина назви" },
    edrpou: { type: 'string', description: 'Код ЄДРПОУ боржника' },
    collection_category: { type: 'string' },
    limit: { type: 'number' },
    offset: { type: 'number' },
  },
};

describe('tool-args-validator', () => {
  const env = process.env.TOOL_ARGS_STRICT;
  afterEach(() => {
    if (env === undefined) delete process.env.TOOL_ARGS_STRICT;
    else process.env.TOOL_ARGS_STRICT = env;
  });

  it('flags the audit case: search_debtors {name} is unknown', () => {
    expect(findUnknownArgs(debtorsSchema, { name: 'НАФТОГАЗ', limit: 3 })).toEqual(['name']);
  });

  it('accepts schema arguments', () => {
    expect(findUnknownArgs(debtorsSchema, { query: 'НАФТОГАЗ', limit: 3 })).toEqual([]);
  });

  it('allows underscore-prefixed meta/internal args and budget hints', () => {
    expect(findUnknownArgs(debtorsSchema, {
      query: 'x', _meta: { progressToken: 1 }, _skip_fts_leg: true, _fallback_from: 'fulltext',
      budget: 'quick', reasoning_budget: 'deep',
    })).toEqual([]);
  });

  it('never rejects open or property-less schemas', () => {
    expect(allowedArgNames({ type: 'object', properties: { a: {} }, additionalProperties: true })).toBeNull();
    expect(allowedArgNames({ type: 'object', properties: { a: {} }, additionalProperties: { type: 'string' } })).toBeNull();
    expect(allowedArgNames({ type: 'object', patternProperties: { '^x': {} } })).toBeNull();
    expect(allowedArgNames({ type: 'object' })).toBeNull();
    expect(allowedArgNames({ type: 'object', properties: {} })).toBeNull();
    expect(allowedArgNames(undefined)).toBeNull();
    expect(findUnknownArgs({ type: 'object' }, { anything: 1 })).toEqual([]);
  });

  it('additionalProperties:false with properties is enforced', () => {
    expect(findUnknownArgs({ type: 'object', properties: { a: {} }, additionalProperties: false }, { b: 1 })).toEqual(['b']);
  });

  it('collects properties from anyOf/oneOf/allOf branches', () => {
    const schema = { type: 'object', anyOf: [{ properties: { a: {} } }, { properties: { b: {} } }] };
    expect(findUnknownArgs(schema, { a: 1, b: 2, c: 3 })).toEqual(['c']);
  });

  it('ignores non-object args', () => {
    expect(findUnknownArgs(debtorsSchema, null)).toEqual([]);
    expect(findUnknownArgs(debtorsSchema, ['x'])).toEqual([]);
  });

  it('returns a Ukrainian isError result listing the valid args', () => {
    const r = checkToolArgs('openreyestr_search_debtors', debtorsSchema, { name: 'НАФТОГАЗ' }, 'test');
    expect(r?.isError).toBe(true);
    const text = r!.content[0].text;
    expect(text).toContain('Невідомі параметри інструмента openreyestr_search_debtors: name');
    expect(text).toContain('• query');
    expect(text).toContain('• edrpou');
  });

  it('TOOL_ARGS_STRICT=false only logs', () => {
    process.env.TOOL_ARGS_STRICT = 'false';
    expect(checkToolArgs('t', debtorsSchema, { name: 'x' }, 'test')).toBeNull();
  });
});

class FakeHandler extends BaseToolHandler {
  getToolDefinitions(): ToolDefinition[] {
    return [{
      name: 'local_tool',
      description: 'd',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    }];
  }
  async executeTool(): Promise<ToolResult | null> { return null; }
}

describe('ToolRegistry.validateToolArgs', () => {
  const remoteClient: any = {
    getServiceConfig: (svc: string) => ({ baseUrl: `http://${svc}`, apiKey: 'k' }),
    fetchRemoteToolDefinitions: async (baseUrl: string) => baseUrl === 'http://openreyestr'
      ? [{ name: 'search_debtors', description: 'd', inputSchema: debtorsSchema }]
      : [],
  };

  it('rejects unknown args for local tools', async () => {
    const reg = new ToolRegistry(remoteClient);
    reg.registerHandler(new FakeHandler());
    expect(await reg.validateToolArgs('local_tool', { query: 'x' }, 'test')).toBeNull();
    const r = await reg.validateToolArgs('local_tool', { q: 'x' }, 'test');
    expect(r?.isError).toBe(true);
  });

  it('rejects unknown args for proxied openreyestr tools using the remote schema', async () => {
    const reg = new ToolRegistry(remoteClient);
    const r = await reg.validateToolArgs('openreyestr_search_debtors', { name: 'НАФТОГАЗ', limit: 3 }, 'test');
    expect(r?.isError).toBe(true);
    expect(r!.content[0].text).toContain('name');
    expect(await reg.validateToolArgs('openreyestr_search_debtors', { query: 'НАФТОГАЗ' }, 'test')).toBeNull();
  });

  it('lets calls through when the schema is unknown', async () => {
    const reg = new ToolRegistry({ ...remoteClient, fetchRemoteToolDefinitions: async () => [] });
    expect(await reg.validateToolArgs('openreyestr_search_debtors', { name: 'x' }, 'test')).toBeNull();
    expect(await reg.validateToolArgs('no_such_tool', { name: 'x' }, 'test')).toBeNull();
  });
});
