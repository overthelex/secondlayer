import request from 'supertest';
import { createHmac } from 'crypto';
import { createApp } from '../server';
import { LoginRateLimit } from '../auth/rate-limit';
import { loadTenant } from '../tenant';
import { EventHub } from '../pbx/hub';
import type { PbxService } from '../pbx/calls';
import { ValidationError } from '../leads/repo';
import { loadConfig, parseAgents } from '../config';

type Row = Record<string, unknown>;

function fakePool() {
  const calls: { text: string; values?: unknown[] }[] = [];
  const handlers: ((text: string, values?: unknown[]) => Row[] | undefined)[] = [];
  return {
    calls,
    on: (h: (text: string, values?: unknown[]) => Row[] | undefined) => handlers.push(h),
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      for (const h of handlers) {
        const r = h(text, values);
        if (r) return { rows: r, rowCount: r.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const config = { port: 0, databaseUrl: 'x', sessionSecret: 's', derivationLagDays: 30, derivationBatch: 2000, derivationEnabled: false, tenant: loadTenant({}), publicUrl: 'https://attorney.legal.org.ua', smtpUrl: null, mailFrom: 'v@legal.org.ua', replyTo: null, unsubscribeMailbox: 'unsubscribe@legal.org.ua', pbx: null };
const advocateRow = { source_id: '42', family_name: 'Коваль', first_name: 'Іван', patronymic: 'Петрович', status: 'active', status_description: null, phone: '+38(044)1234567, 0505005134', email: 'k@x', city: 'Київ', region: 'м. Київ', org_forms: null, ra_name: 'РА', certificate_num: '1/1', certificate_date: null, stage: null, next_contact_at: null, manual_practices: null, last_contact: null, kind_cases: 0, kind_summary: null };

function sessionFor(pool: ReturnType<typeof fakePool>) {
  pool.on((t, v) =>
    t.includes('FROM attorney_crm_sessions') && v?.[0] === createHmac('sha256', config.sessionSecret).update('tok').digest('hex')
      ? [{ id: 1, email: 'v@legal.org.ua', display_name: 'V', expires_at: new Date('2030-01-01') }]
      : undefined,
  );
  pool.on((t, v) => (t.includes('WHERE a.source_id = $1') ? (v?.[0] === '42' ? [advocateRow] : []) : undefined));
}

function fakeService(impl?: (sourceId: string, number: string) => Promise<unknown>) {
  const started: { sourceId: string; number: string; user: unknown; name: string }[] = [];
  const service = {
    startOutbound: async (sourceId: string, number: string, user: unknown, name: string) => {
      started.push({ sourceId, number, user, name });
      if (impl) return impl(sourceId, number);
      return { channelId: 'crm-1', number };
    },
  } as unknown as PbxService;
  return { service, started };
}

test('without a PBX the card shows plain phones and no call route', async () => {
  const pool = fakePool();
  sessionFor(pool);
  const app = createApp({ pool: pool as any, config, rateLimit: new LoginRateLimit() });
  const page = await request(app).get('/advocates/42').set('Cookie', 'acrm_session=tok');
  expect(page.status).toBe(200);
  expect(page.text).not.toContain('/advocates/42/call');
  expect(page.text).not.toContain('pbx.js');
  const res = await request(app).post('/advocates/42/call').set('Cookie', 'acrm_session=tok').type('form').send({ number: '0505005134' });
  expect(res.status).toBe(404);
});

test('with a PBX each phone gets a «Подзвонити» button and the events script is loaded', async () => {
  const pool = fakePool();
  sessionFor(pool);
  const app = createApp({ pool: pool as any, config, rateLimit: new LoginRateLimit(), pbx: { service: fakeService().service, hub: new EventHub() } });
  const page = await request(app).get('/advocates/42').set('Cookie', 'acrm_session=tok');
  expect(page.status).toBe(200);
  expect(page.text.match(/action="\/advocates\/42\/call"/g)).toHaveLength(2);
  expect(page.text).toContain('name="number" value="0505005134"');
  expect(page.text).toContain('☎ Подзвонити');
  expect(page.text).toContain('/static/pbx.js?v=');
  expect(page.text).toContain('data-incoming="Вхідний дзвінок"');
});

test('POST /advocates/:id/call starts the call as the signed-in user and redirects back', async () => {
  const pool = fakePool();
  sessionFor(pool);
  const { service, started } = fakeService();
  const app = createApp({ pool: pool as any, config, rateLimit: new LoginRateLimit(), pbx: { service, hub: new EventHub() } });
  const res = await request(app).post('/advocates/42/call').set('Cookie', 'acrm_session=tok').type('form').send({ number: '+38(044)1234567' });
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe('/advocates/42');
  expect(started).toEqual([{ sourceId: '42', number: '+38(044)1234567', user: { id: 1, email: 'v@legal.org.ua', displayName: 'V' }, name: 'Коваль Іван Петрович' }]);
});

test('POST /advocates/:id/call: bad number → 400, PBX failure → 502, unknown lawyer → 404, no session → login', async () => {
  const pool = fakePool();
  sessionFor(pool);
  const hub = new EventHub();
  let app = createApp({ pool: pool as any, config, rateLimit: new LoginRateLimit(), pbx: { service: fakeService(async () => { throw new ValidationError('Не схоже на український номер: 12'); }).service, hub } });
  let res = await request(app).post('/advocates/42/call').set('Cookie', 'acrm_session=tok').type('form').send({ number: '12' });
  expect(res.status).toBe(400);
  expect(res.text).toContain('Не схоже на український номер');
  app = createApp({ pool: pool as any, config, rateLimit: new LoginRateLimit(), pbx: { service: fakeService(async () => { throw new Error('ARI POST /channels → 503'); }).service, hub } });
  res = await request(app).post('/advocates/42/call').set('Cookie', 'acrm_session=tok').type('form').send({ number: '0505005134' });
  expect(res.status).toBe(502);
  expect(res.text).toContain('АТС не відповідає');
  res = await request(app).post('/advocates/77/call').set('Cookie', 'acrm_session=tok').type('form').send({ number: '0505005134' });
  expect(res.status).toBe(404);
  res = await request(app).post('/advocates/42/call').type('form').send({ number: '0505005134' });
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe('/login');
});

test('GET /pbx/events streams server-sent events to a signed-in browser', async () => {
  const pool = fakePool();
  sessionFor(pool);
  const hub = new EventHub(10_000);
  const app = createApp({ pool: pool as any, config, rateLimit: new LoginRateLimit(), pbx: { service: fakeService().service, hub } });
  const anon = await request(app).get('/pbx/events');
  expect(anon.status).toBe(302);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/pbx/events`, { headers: { Cookie: 'acrm_session=tok' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain(': connected');
    for (let i = 0; i < 50 && hub.size === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(hub.size).toBe(1);
    hub.publish({ type: 'inbound', number: '+380 50 500 51 34', advocate: null });
    const second = new TextDecoder().decode((await reader.read()).value);
    expect(second).toBe('event: inbound\ndata: {"type":"inbound","number":"+380 50 500 51 34","advocate":null}\n\n');
    await reader.cancel();
  } finally {
    hub.close();
    server.close();
  }
});

test('loadConfig: ARI settings are optional, incomplete ones fail fast, agents map parses', () => {
  const base = { DATABASE_URL: 'x', ATTORNEY_CRM_SESSION_SECRET: 's' };
  expect(loadConfig(base).pbx).toBeNull();
  expect(() => loadConfig({ ...base, ATTORNEY_CRM_ARI_URL: 'https://pbx:8089/ari' })).toThrow('ATTORNEY_CRM_ARI_USER');
  expect(() => loadConfig({ ...base, ATTORNEY_CRM_ARI_URL: 'pbx:8089', ATTORNEY_CRM_ARI_USER: 'crm', ATTORNEY_CRM_ARI_PASSWORD: 'p' })).toThrow('http');
  const c = loadConfig({ ...base, ATTORNEY_CRM_ARI_URL: 'https://pbx:8089/ari', ATTORNEY_CRM_ARI_USER: 'crm', ATTORNEY_CRM_ARI_PASSWORD: 'p', ATTORNEY_CRM_ARI_CERT_SHA256: 'AB:CD', ATTORNEY_CRM_PBX_AGENTS: 'igor@legal.org.ua=igor, bad=no spaces' });
  expect(c.pbx).toEqual({ ariUrl: 'https://pbx:8089/ari', ariUser: 'crm', ariPassword: 'p', ariApp: 'crm', certSha256: 'AB:CD', agents: { 'igor@legal.org.ua': 'igor' }, noteUserEmail: 'vladimir@legal.org.ua', outboundContext: 'outbound', countryCode: '380' });
  expect(parseAgents(undefined)).toEqual({});
  expect(loadConfig({ ...base, ATTORNEY_CRM_TENANT: 'pl', ATTORNEY_CRM_ARI_URL: 'http://127.0.0.1:8088/ari', ATTORNEY_CRM_ARI_USER: 'crm', ATTORNEY_CRM_ARI_PASSWORD: 'p' }).pbx?.countryCode).toBe('48');
});
