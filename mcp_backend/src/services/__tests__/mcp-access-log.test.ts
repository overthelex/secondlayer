import { describe, it, expect, jest } from '@jest/globals';
import { callerFromHeaders, logMcpAccess } from '../mcp-access-log.js';

describe('callerFromHeaders', () => {
  it('prefers CF-Connecting-IP over X-Forwarded-For and the socket address', () => {
    const c = callerFromHeaders(
      { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '10.0.0.1, 10.0.0.2', 'user-agent': 'claude-code/2.1' },
      '172.18.0.5'
    );
    expect(c).toEqual({ clientIp: '203.0.113.7', userAgent: 'claude-code/2.1' });
  });

  it('takes the first X-Forwarded-For hop when Cloudflare header is absent', () => {
    expect(callerFromHeaders({ 'x-forwarded-for': '198.51.100.4, 10.0.0.2' }).clientIp).toBe('198.51.100.4');
  });

  it('drops values Postgres INET would reject instead of failing the insert', () => {
    const c = callerFromHeaders({ 'cf-connecting-ip': 'not-an-ip', 'x-forwarded-for': 'unknown' }, '::ffff:172.18.0.5');
    expect(c.clientIp).toBe('172.18.0.5');
    expect(callerFromHeaders({}).clientIp).toBeNull();
  });

  it('accepts IPv6 and a fetch Headers object', () => {
    const h = new Headers({ 'cf-connecting-ip': '2001:db8::1', 'user-agent': 'x' });
    expect(callerFromHeaders(h)).toEqual({ clientIp: '2001:db8::1', userAgent: 'x' });
  });

  it('caps the User-Agent length', () => {
    expect(callerFromHeaders({ 'user-agent': 'a'.repeat(2000) }).userAgent).toHaveLength(512);
  });
});

describe('logMcpAccess', () => {
  it('stores only a 12-char key prefix, never the full key', async () => {
    const query = jest.fn<(sql: string, params: unknown[]) => Promise<unknown>>().mockResolvedValue({});
    logMcpAccess({ query }, {
      transport: 'v2/mcp',
      outcome: 'invalid_api_key',
      token: 'sl_abcdefghijklmnopqrstuvwxyz012345_deadbeef',
      caller: { clientIp: '203.0.113.7', userAgent: 'ua' },
    });
    const params = query.mock.calls[0][1];
    expect(params[5]).toBe('sl_abcdefghi');
    expect(JSON.stringify(params)).not.toContain('deadbeef');
  });

  it('never throws when the insert fails', async () => {
    const query = jest.fn<(sql: string, params: unknown[]) => Promise<unknown>>().mockRejectedValue(new Error('db down'));
    expect(() => logMcpAccess({ query }, {
      transport: 'v2/mcp', outcome: 'missing_auth', caller: { clientIp: null, userAgent: null },
    })).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });
});
