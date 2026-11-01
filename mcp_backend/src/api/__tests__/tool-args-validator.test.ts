/**
 * LEXAI-2164: unknown tool arguments are rejected with a Ukrainian message listing the
 * valid ones, instead of being silently dropped.
 */

import { allowedArgNames, findUnknownArgs, checkToolArgs } from '../tool-args-validator.js';
import { ToolRegistry } from '../tool-registry.js';
import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';
import { createToolArgsValidationMiddleware } from '../../routes/tool-execution-routes.js';

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

  it('collects properties from anyOf/oneOf branches (union)', () => {
    const schema = { type: 'object', anyOf: [{ properties: { a: {} } }, { properties: { b: {} } }] };
    expect(findUnknownArgs(schema, { a: 1, b: 2, c: 3 })).toEqual(['c']);
    const one = { type: 'object', oneOf: [{ properties: { a: {} } }, { properties: { b: {} } }] };
    expect(findUnknownArgs(one, { b: 2, c: 3 })).toEqual(['c']);
  });

  it('fails open on allOf (no union of branches)', () => {
    const schema = { type: 'object', allOf: [{ properties: { a: {} } }, { properties: { b: {} } }] };
    expect(allowedArgNames(schema)).toBeNull();
    expect(findUnknownArgs(schema, { c: 3 })).toEqual([]);
    const nested = { type: 'object', anyOf: [{ allOf: [{ properties: { a: {} } }] }] };
    expect(findUnknownArgs(nested, { c: 3 })).toEqual([]);
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
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      expect(checkToolArgs('t', debtorsSchema, { name: 'x' }, 'test')).toBeNull();
      expect(warn).toHaveBeenCalledWith('[ToolArgs] Unknown tool arguments',
        expect.objectContaining({ tool: 't', unknown: ['name'], transport: 'test', action: 'logged' }));
    } finally {
      warn.mockRestore();
    }
  });

  it('logs rejections with action rejected', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      expect(checkToolArgs('t', debtorsSchema, { name: 'x' }, 'mcp')).not.toBeNull();
      expect(warn).toHaveBeenCalledWith('[ToolArgs] Unknown tool arguments',
        expect.objectContaining({ unknown: ['name'], transport: 'mcp', action: 'rejected' }));
    } finally {
      warn.mockRestore();
    }
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

  it('concurrent first calls share one in-flight fetch and all validate', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(r => { release = r; });
    const fetch = jest.fn(async (baseUrl: string) => {
      await gate;
      return remoteClient.fetchRemoteToolDefinitions(baseUrl);
    });
    const reg = new ToolRegistry({ ...remoteClient, fetchRemoteToolDefinitions: fetch });
    const calls = [1, 2, 3].map(() =>
      reg.validateToolArgs('openreyestr_search_debtors', { name: 'НАФТОГАЗ' }, 'test'));
    release();
    const results = await Promise.all(calls);
    for (const r of results) expect(r?.isError).toBe(true);
    // Only the owning service, once.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('http://openreyestr', 'k');
  });

  it('does not cache a failed fetch; retries after the backoff', async () => {
    let fail = true;
    const fetch = jest.fn(async (baseUrl: string) => (fail ? [] : remoteClient.fetchRemoteToolDefinitions(baseUrl)));
    const reg = new ToolRegistry({ ...remoteClient, fetchRemoteToolDefinitions: fetch });
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      expect(await reg.validateToolArgs('openreyestr_search_debtors', { name: 'x' }, 'test')).toBeNull();
      fail = false;
      // Inside the backoff: no new request, still fail-open.
      now.mockReturnValue(1_010_000);
      expect(await reg.validateToolArgs('openreyestr_search_debtors', { name: 'x' }, 'test')).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
      // After the backoff: refetched, cached, enforced.
      now.mockReturnValue(1_031_000);
      expect((await reg.validateToolArgs('openreyestr_search_debtors', { name: 'x' }, 'test'))?.isError).toBe(true);
      expect((await reg.validateToolArgs('openreyestr_search_debtors', { name: 'x' }, 'test'))?.isError).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('fails open when the owning service schema fetch hangs', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const reg = new ToolRegistry({ ...remoteClient, fetchRemoteToolDefinitions: () => new Promise(() => undefined) });
      const p = reg.validateToolArgs('openreyestr_search_debtors', { name: 'x' }, 'test');
      await jest.advanceTimersByTimeAsync(6_001);
      expect(await p).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('getAllToolDefinitions lists the services that answered, and retries the one that did not', async () => {
    let radaUp = false;
    const fetch = jest.fn(async (baseUrl: string) => {
      if (baseUrl === 'http://rada') return radaUp ? [{ name: 'get_deputy_info', description: 'd', inputSchema: {} }] : [];
      return remoteClient.fetchRemoteToolDefinitions(baseUrl);
    });
    const reg = new ToolRegistry({ ...remoteClient, fetchRemoteToolDefinitions: fetch });
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(2_000_000);
      expect((await reg.getAllToolDefinitions()).map(d => d.name)).toEqual(['openreyestr_search_debtors']);
      radaUp = true;
      now.mockReturnValue(2_031_000);
      expect((await reg.getAllToolDefinitions()).map(d => d.name).sort())
        .toEqual(['openreyestr_search_debtors', 'rada_get_deputy_info']);
    } finally {
      now.mockRestore();
    }
  });
});

describe('createToolArgsValidationMiddleware (REST, before limits/billing)', () => {
  const registry = {
    validateToolArgs: jest.fn(async (name: string, args: any) =>
      args && 'name' in args ? { content: [{ type: 'text', text: `bad ${name}` }], isError: true } : null),
  };
  const mw = createToolArgsValidationMiddleware(registry as any);

  function run(req: any) {
    const res: any = { statusCode: 200, body: undefined };
    res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
    res.json = jest.fn((b: any) => { res.body = b; return res; });
    const next = jest.fn();
    return mw({ path: '/', params: {}, body: {}, ...req } as any, res, next).then(() => ({ res, next }));
  }

  it('single call with unknown args: 400, never reaches the limit/billing middlewares', async () => {
    const { res, next } = await run({ path: '/search_court_decisions', params: { toolName: 'search_court_decisions' }, body: { arguments: { name: 'x' } } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: 'Invalid arguments', message: 'bad search_court_decisions' });
    expect(next).not.toHaveBeenCalled();
    expect(registry.validateToolArgs).toHaveBeenLastCalledWith('search_court_decisions', { name: 'x' }, 'rest');
  });

  it('valid single call passes; stream route is tagged rest-stream', async () => {
    const { next } = await run({ path: '/search_court_decisions/stream', params: { toolName: 'search_court_decisions' }, body: { query: 'x' } });
    expect(next).toHaveBeenCalled();
    expect(registry.validateToolArgs).toHaveBeenLastCalledWith('search_court_decisions', { query: 'x' }, 'rest-stream');
  });

  it('batch: any invalid call rejects the whole batch with 400 and the invalid list', async () => {
    const { res, next } = await run({ path: '/batch', body: { calls: [
      { name: 'search_court_decisions', arguments: { query: 'x' } },
      { name: 'search_registry', arguments: { name: 'x' } },
    ] } });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body.invalid).toEqual([{ index: 1, name: 'search_registry', message: 'bad search_registry' }]);
  });

  it('batch of valid calls passes', async () => {
    const { next } = await run({ path: '/batch', body: { calls: [{ name: 'search_court_decisions', arguments: { query: 'x' } }] } });
    expect(next).toHaveBeenCalled();
  });

  it('fails open if validation throws', async () => {
    const broken = createToolArgsValidationMiddleware({ validateToolArgs: async () => { throw new Error('boom'); } } as any);
    const next = jest.fn();
    await broken({ path: '/x', params: { toolName: 'search_court_decisions' }, body: {} } as any, {} as any, next);
    expect(next).toHaveBeenCalled();
  });
});
