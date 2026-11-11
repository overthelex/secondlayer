import { AriClient, AriError, normaliseFingerprint, runEventLoop, type AriEvent, type EventSocket } from '../pbx/ari';

function fakeFetch(status = 200, body = '{"id":"crm-1","state":"Down"}') {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body?: string } }[] = [];
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, init });
    return { status, text: async () => body };
  };
  return { calls, fetch };
}

const opts = { url: 'https://pbx.example:8089/ari/', user: 'crm', password: 'p@ss', app: 'crm' };

test('originate posts /channels with endpoint, context, extension, our channel id and basic auth', async () => {
  const f = fakeFetch();
  const ari = new AriClient(opts, { fetch: f.fetch });
  const ch = await ari.originate({ endpoint: 'PJSIP/vladimir', context: 'outbound', extension: '380505005134', channelId: 'crm-1', callerId: '"Коваль" <380505005134>', variables: { CRM_SOURCE_ID: '42' } });
  expect(ch.id).toBe('crm-1');
  expect(f.calls).toHaveLength(1);
  const { url, init } = f.calls[0];
  expect(url.startsWith('https://pbx.example:8089/ari/channels?')).toBe(true);
  const q = new URL(url).searchParams;
  expect(q.get('endpoint')).toBe('PJSIP/vladimir');
  expect(q.get('context')).toBe('outbound');
  expect(q.get('extension')).toBe('380505005134');
  expect(q.get('priority')).toBe('1');
  expect(q.get('channelId')).toBe('crm-1');
  expect(q.get('timeout')).toBe('40');
  expect(q.get('callerId')).toBe('"Коваль" <380505005134>');
  expect(init.method).toBe('POST');
  expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('crm:p@ss').toString('base64')}`);
  expect(JSON.parse(init.body!)).toEqual({ variables: { CRM_SOURCE_ID: '42' } });
});

test('continueInDialplan and hangup hit the channel routes; an error status throws AriError', async () => {
  const f = fakeFetch(204, '');
  const ari = new AriClient(opts, { fetch: f.fetch });
  await ari.continueInDialplan('1731340000.12');
  await ari.hangup('1731340000.12');
  expect(f.calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
    'POST https://pbx.example:8089/ari/channels/1731340000.12/continue',
    'DELETE https://pbx.example:8089/ari/channels/1731340000.12',
  ]);
  const bad = new AriClient(opts, { fetch: fakeFetch(404, '{"message":"Channel not found"}').fetch });
  await expect(bad.continueInDialplan('x')).rejects.toBeInstanceOf(AriError);
});

test('openEvents builds the wss URL with the app and subscribeAll, auth in a header not the URL', () => {
  let seen: { url: string; headers: Record<string, string> } | null = null;
  const ari = new AriClient(opts, { socketFactory: (url, headers) => ((seen = { url, headers }), { onEvent() {}, onClose() {}, close() {} }) });
  ari.openEvents();
  expect(seen!.url).toBe('wss://pbx.example:8089/ari/events?app=crm&subscribeAll=true');
  expect(seen!.headers.Authorization).toMatch(/^Basic /);
  expect(seen!.url).not.toContain('p@ss');
});

test('normaliseFingerprint strips colons and upper-cases', () => {
  expect(normaliseFingerprint('ab:cd:EF')).toBe('ABCDEF');
  expect(normaliseFingerprint('AB CD ef')).toBe('ABCDEF');
});

test('runEventLoop reconnects after close with backoff and stops on stop()', async () => {
  jest.useFakeTimers();
  const sockets: { close: () => void; closeHandlers: ((r: string) => void)[]; eventHandlers: ((e: AriEvent) => void)[] }[] = [];
  const open = (): EventSocket => {
    const s = { closeHandlers: [] as ((r: string) => void)[], eventHandlers: [] as ((e: AriEvent) => void)[], close: jest.fn() };
    sockets.push(s);
    return { onEvent: (h) => s.eventHandlers.push(h), onClose: (h) => s.closeHandlers.push(h), close: s.close };
  };
  const events: AriEvent[] = [];
  const log: string[] = [];
  const loop = runEventLoop(open, (e) => events.push(e), (l) => log.push(l), { minDelayMs: 100, maxDelayMs: 1000 });
  expect(sockets).toHaveLength(1);
  sockets[0].eventHandlers[0]({ type: 'Ping' });
  expect(events).toEqual([{ type: 'Ping' }]);
  sockets[0].closeHandlers[0]('closed 1006');
  expect(log[0]).toContain('reconnect in 0 s');
  jest.advanceTimersByTime(100);
  expect(sockets).toHaveLength(2);
  sockets[1].closeHandlers[0]('closed 1006');
  jest.advanceTimersByTime(150);
  expect(sockets).toHaveLength(2); // 200 ms now
  jest.advanceTimersByTime(60);
  expect(sockets).toHaveLength(3);
  loop.stop();
  expect(sockets[2].close).toHaveBeenCalled();
  sockets[2].closeHandlers[0]('closed');
  jest.advanceTimersByTime(5000);
  expect(sockets).toHaveLength(3);
  jest.useRealTimers();
});
