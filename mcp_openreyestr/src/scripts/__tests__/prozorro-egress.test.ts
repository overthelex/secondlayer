import http from 'http';
import net from 'net';
import https from 'https';
import { ConnectProxyAgent, createProzorroClient, Lane, onSuccess, onThrottle, parseEgress } from '../lib/prozorro-http';

describe('PROZORRO_EGRESS lanes (LEXAI-2227)', () => {
  it('parses lanes and keeps the old single direct lane by default', () => {
    expect(parseEgress(undefined, 30)).toEqual([{ name: 'direct', proxy: null, workers: 30 }]);
    expect(parseEgress('direct=10, http://127.0.0.1:8201=20', 30)).toEqual([
      { name: 'direct', proxy: null, workers: 10 },
      { name: '127.0.0.1:8201', proxy: 'http://127.0.0.1:8201', workers: 20 },
    ]);
    expect(() => parseEgress('socks5://127.0.0.1:1080=5', 1)).toThrow(/http:\/\//);
    expect(() => parseEgress('direct=0', 1)).toThrow(/worker count/);
    expect(() => parseEgress('direct', 1)).toThrow(/needs/);
  });

  it('reports the lanes and total workers', () => {
    const c = createProzorroClient(5, 0, parseEgress('direct=3,http://127.0.0.1:1=4', 5));
    expect(c.totalWorkers).toBe(7);
    expect(c.lanes.map((l) => l.name)).toEqual(['direct', '127.0.0.1:1']);
    c.destroy();
  });

  it('sends requests through a CONNECT proxy lane', async () => {
    const connects: string[] = [];
    const proxy = http.createServer();
    proxy.on('connect', (req, socket) => {
      connects.push(req.url || '');
      // refuse the tunnel: enough to prove the lane goes through the proxy, without network access
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
    const port = (proxy.address() as net.AddressInfo).port;
    const agent = new ConnectProxyAgent(new URL(`http://127.0.0.1:${port}`), {});
    const err = await new Promise<Error>((resolve) => {
      https.get('https://public-api.prozorro.gov.ua/api/2.5/tenders/x', { agent }, () => resolve(new Error('no'))).on('error', resolve);
    });
    expect(err.message).toMatch(/CONNECT 403/);
    expect(connects[0]).toBe('public-api.prozorro.gov.ua:443');
    agent.destroy();
    proxy.close();
  });
});

describe('adaptive lanes (AIMD)', () => {
  const lane = (): Lane => ({ name: 'x', proxy: null, workers: 20, agent: null as any, pausedUntil: 0, active: 20, lastThrottle: 0, lastChange: 0 });

  it('cuts a quarter on a 429, at most once per cooldown, never below 1', () => {
    const l = lane();
    expect(onThrottle(l, 100_000)).toBe(true);
    expect(l.active).toBe(15);
    expect(onThrottle(l, 101_000)).toBe(false); // a burst of 429s is one cut
    expect(l.active).toBe(15);
    let t = 100_000;
    for (let i = 0; i < 20; i++) onThrottle(l, (t += 6_000));
    expect(l.active).toBe(1);
  });

  it('adds one worker back per step after a quiet period, up to the ceiling', () => {
    const l = lane();
    onThrottle(l, 100_000);
    expect(onSuccess(l, 110_000)).toBe(false); // not quiet yet
    expect(onSuccess(l, 131_000)).toBe(true);
    expect(l.active).toBe(16);
    expect(onSuccess(l, 135_000)).toBe(false); // one step per 10 s
    let t = 131_000;
    for (let i = 0; i < 10; i++) onSuccess(l, (t += 10_000));
    expect(l.active).toBe(20);
  });
});
