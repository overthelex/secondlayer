import type { Request } from 'express';
import {
  extractTurnstileToken,
  requireTurnstile,
  turnstileRequired,
  verifyTurnstileToken,
} from '../turnstile-service.js';

function req(overrides: Partial<Request> & { headers?: Record<string, string>; body?: unknown } = {}): Request {
  return {
    headers: {},
    body: {},
    path: '/auth/login',
    ip: '203.0.113.7',
    ...overrides,
  } as unknown as Request;
}

describe('turnstile-service', () => {
  const originalSecret = process.env.TURNSTILE_SECRET_KEY;
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = originalSecret;
  });

  it('is disabled when no secret is configured', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    expect(turnstileRequired(req({ headers: { 'user-agent': 'Mozilla/5.0' } }))).toBe(false);
    expect(await requireTurnstile(req())).toBeNull();
  });

  it('exempts the native mobile app (Dart) but not browsers', () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    expect(turnstileRequired(req({ headers: { 'user-agent': 'Dart/3.5 (dart:io)' } }))).toBe(false);
    expect(turnstileRequired(req({ headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux)' } }))).toBe(true);
    expect(turnstileRequired(req({ headers: {} }))).toBe(true);
  });

  it('reads the token from body or header and rejects junk', () => {
    expect(extractTurnstileToken(req({ body: { turnstileToken: 'abc' } }))).toBe('abc');
    expect(extractTurnstileToken(req({ headers: { 'cf-turnstile-response': 'hdr' } }))).toBe('hdr');
    expect(extractTurnstileToken(req({ body: { turnstileToken: 42 } }))).toBeNull();
    expect(extractTurnstileToken(req({ body: { turnstileToken: 'x'.repeat(3000) } }))).toBeNull();
    expect(extractTurnstileToken(req())).toBeNull();
  });

  it('rejects a browser request without a token when enabled', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    const verdict = await requireTurnstile(req({ headers: { 'user-agent': 'Mozilla/5.0' } }));
    expect(verdict?.status).toBe(403);
    expect(verdict?.body.code).toBe('TURNSTILE_REQUIRED');
  });

  it('passes siteverify success and fails on siteverify failure', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    const okFetch = (async () => ({ json: async () => ({ success: true }) })) as unknown as typeof fetch;
    const badFetch = (async () => ({ json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) })) as unknown as typeof fetch;
    expect((await verifyTurnstileToken('t', '1.2.3.4', okFetch)).ok).toBe(true);
    const bad = await verifyTurnstileToken('t', '1.2.3.4', badFetch);
    expect(bad.ok).toBe(false);
    expect(bad.codes).toContain('invalid-input-response');
  });

  it('fails open when siteverify is unreachable', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    const downFetch = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    const verdict = await verifyTurnstileToken('t', undefined, downFetch);
    expect(verdict.ok).toBe(true);
    expect(verdict.codes).toContain('siteverify-unreachable');
  });
});
