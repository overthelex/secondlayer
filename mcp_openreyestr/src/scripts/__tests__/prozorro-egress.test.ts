import http from 'http';
import net from 'net';
import https from 'https';
import { ConnectProxyAgent, createProzorroClient, parseEgress } from '../lib/prozorro-http';

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
