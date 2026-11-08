import { ProxyAgent } from 'undici';
import { Collector, CollectorStopped } from '../collector/http';

function fakeFetch(responses: { status: number; body?: string }[]) {
  const calls: { url: string; init: any }[] = [];
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const r = responses.shift() ?? { status: 200, body: 'ok' };
    return new Response(r.body ?? '', { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function collector(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof Collector>[0]> = {}) {
  const sleeps: number[] = [];
  let t = 0;
  const c = new Collector({
    userAgent: 'test-ua',
    minDelayMs: { 'rejestradwokatow.pl': 10_000, 'rejestrradcow.pl': 1000 },
    maxConsecutiveFailures: 5,
    fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    now: () => t,
    ...extra,
  });
  return { c, sleeps };
}

test('spaces requests per host and sends the user agent', async () => {
  const f = fakeFetch([{ status: 200, body: 'a' }, { status: 200, body: 'b' }, { status: 200, body: 'c' }]);
  const { c, sleeps } = collector(f.impl);
  await c.get('https://rejestradwokatow.pl/adwokat/list/strona/1');
  await c.get('https://rejestradwokatow.pl/adwokat/list/strona/2');
  await c.get('https://rejestrradcow.pl/Home/Index');
  expect(sleeps.filter((s) => s >= 10_000)).toHaveLength(1);
  expect(f.calls[0].init.headers['user-agent']).toBe('test-ua');
});

test('backs off on 429 then succeeds', async () => {
  const f = fakeFetch([{ status: 429 }, { status: 200, body: 'fine' }]);
  const { c, sleeps } = collector(f.impl);
  expect(await c.get('https://rejestrradcow.pl/x')).toBe('fine');
  expect(sleeps).toContain(10_000);
  expect(c.failures).toBe(0);
});

test('stops after five consecutive failures', async () => {
  const f = fakeFetch(Array.from({ length: 40 }, () => ({ status: 500 })));
  const { c } = collector(f.impl);
  await expect(c.get('https://rejestrradcow.pl/x')).rejects.toBeInstanceOf(CollectorStopped);
});

test('a 404 is a soft miss, not a failure', async () => {
  const f = fakeFetch([{ status: 404 }]);
  const { c } = collector(f.impl);
  await expect(c.get('https://rejestrradcow.pl/x')).rejects.toThrow(/404/);
  expect(c.failures).toBe(0);
});

test('ProxyAgent is used when proxyUrl is set', async () => {
  const f = fakeFetch([{ status: 200, body: 'p' }]);
  const { c } = collector(f.impl, { proxyUrl: 'http://127.0.0.1:8118' });
  await c.get('https://rejestrradcow.pl/x');
  expect(f.calls[0].init.dispatcher).toBeInstanceOf(ProxyAgent);
});

test('post sends a form body', async () => {
  const f = fakeFetch([{ status: 200, body: 'rows' }]);
  const { c } = collector(f.impl);
  expect(await c.post('https://rejestrradcow.pl/Home/GetDataW', { stan: '1', page: '2' })).toBe('rows');
  expect(f.calls[0].init.method).toBe('POST');
  expect(String(f.calls[0].init.body)).toBe('stan=1&page=2');
});
