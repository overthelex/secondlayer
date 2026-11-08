import request from 'supertest';
import { createApp } from '../server';
import { LoginRateLimit } from '../auth/rate-limit';
import { loadTenant } from '../tenant';
import { signUnsubscribeToken } from '../mail/token';

type Row = Record<string, unknown>;

function fakePool() {
  const calls: { text: string; values?: unknown[] }[] = [];
  return {
    calls,
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      if (text.includes('INSERT INTO attorney_crm_suppression')) {
        return { rows: [{ email: values?.[0], reason: values?.[1], source: values?.[2], advocate_source_id: null, detail: null, created_at: new Date() } as Row], rowCount: 1 };
      }
      return { rows: [] as Row[], rowCount: 0 };
    },
  };
}

const config = {
  port: 0, databaseUrl: 'x', sessionSecret: 'secret', derivationLagDays: 30, derivationBatch: 2000, derivationEnabled: false, tenant: loadTenant({}),
  publicUrl: 'https://attorney.legal.org.ua', smtpUrl: null, mailFrom: 'v@legal.org.ua', replyTo: null, unsubscribeMailbox: 'unsubscribe@legal.org.ua',
};

const app = (pool: ReturnType<typeof fakePool>) => createApp({ pool: pool as any, config, rateLimit: new LoginRateLimit() });

test('GET /u/:token with a valid token shows the confirmation and changes nothing', async () => {
  const pool = fakePool();
  const token = signUnsubscribeToken('secret', 'adv@example.ua');
  const res = await request(app(pool)).get(`/u/${token}`);
  expect(res.status).toBe(200);
  expect(res.text).toContain('Відписатися від листів');
  expect(res.text).toContain('adv@example.ua');
  expect(res.text).toContain(`action="/u/${token}"`);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(pool.calls.some((c) => c.text.includes('attorney_crm_suppression'))).toBe(false);
});

test('GET /u/:token with a forged token is 404 and never touches the database', async () => {
  const pool = fakePool();
  const res = await request(app(pool)).get('/u/YUBiLnVh.AAAAAAAAAAAAAAAAAAAAAA');
  expect(res.status).toBe(404);
  expect(res.text).toContain('Посилання недійсне');
  expect(pool.calls.some((c) => c.text.includes('attorney_crm_suppression'))).toBe(false);
});

test('POST /u/:token from the page records an unsubscribe from the link', async () => {
  const pool = fakePool();
  const token = signUnsubscribeToken('secret', 'adv@example.ua');
  const res = await request(app(pool)).post(`/u/${token}`).type('form').send({});
  expect(res.status).toBe(200);
  expect(res.text).toContain('Готово');
  const ins = pool.calls.find((c) => c.text.includes('INSERT INTO attorney_crm_suppression'));
  expect(ins?.values).toEqual(['adv@example.ua', 'unsubscribe', 'link', null, null]);
});

test('POST /u/:token with the RFC 8058 body is recorded as one-click', async () => {
  const pool = fakePool();
  const token = signUnsubscribeToken('secret', 'adv@example.ua');
  const res = await request(app(pool)).post(`/u/${token}`).type('form').send('List-Unsubscribe=One-Click');
  expect(res.status).toBe(200);
  const ins = pool.calls.find((c) => c.text.includes('INSERT INTO attorney_crm_suppression'));
  expect(ins?.values?.[2]).toBe('one-click');
});

test('POST /u/:token with a bad token is 404', async () => {
  const pool = fakePool();
  const res = await request(app(pool)).post('/u/bad').type('form').send('List-Unsubscribe=One-Click');
  expect(res.status).toBe(404);
  expect(pool.calls.some((c) => c.text.includes('attorney_crm_suppression'))).toBe(false);
});

test('the unsubscribe page needs no session (sits before requireLogin)', async () => {
  const token = signUnsubscribeToken('secret', 'adv@example.ua');
  const res = await request(app(fakePool())).get(`/u/${token}`);
  expect(res.status).not.toBe(302);
});
