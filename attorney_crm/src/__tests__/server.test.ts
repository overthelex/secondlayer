import request from 'supertest';
import { createHash } from 'crypto';
import { createApp } from '../server';
import { LoginRateLimit } from '../auth/rate-limit';
import { hashPassword } from '../auth/password';

type Row = Record<string, unknown>;

// A fake pool that answers by SQL shape; tests register handlers as needed.
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

const config = { port: 0, databaseUrl: 'x', sessionSecret: 's', derivationLagDays: 30, derivationBatch: 2000, derivationEnabled: false };

function appWith(pool: ReturnType<typeof fakePool>, rateLimit = new LoginRateLimit()) {
  return createApp({ pool: pool as any, config, rateLimit });
}

function sessionFor(pool: ReturnType<typeof fakePool>, token: string) {
  pool.on((t, v) =>
    t.includes('FROM attorney_crm_sessions') && v?.[0] === createHash('sha256').update(token).digest('hex')
      ? [{ id: 1, email: 'v@legal.org.ua', display_name: 'V', expires_at: new Date('2030-01-01') }]
      : undefined,
  );
}

test('GET /advocates without a cookie redirects to /login', async () => {
  const res = await request(appWith(fakePool())).get('/advocates');
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe('/login');
});

test('GET /healthz answers without a session', async () => {
  const res = await request(appWith(fakePool())).get('/healthz');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true });
});

test('POST /login with a wrong password re-renders with the error; 10 failures → 429', async () => {
  const pool = fakePool();
  const hash = await hashPassword('right');
  pool.on((t) => (t.includes('FROM attorney_crm_users WHERE email') ? [{ id: 1, email: 'v@legal.org.ua', display_name: 'V', password_hash: hash }] : undefined));
  const app = appWith(pool);
  let res = await request(app).post('/login').type('form').send({ email: 'v@legal.org.ua', password: 'wrong' });
  expect(res.status).toBe(200);
  expect(res.text).toContain('Невірний e-mail або пароль');
  for (let i = 0; i < 9; i++) await request(app).post('/login').type('form').send({ email: 'V@legal.org.ua', password: 'wrong' });
  res = await request(app).post('/login').type('form').send({ email: 'v@legal.org.ua', password: 'right' });
  expect(res.status).toBe(429);
  expect(res.text).toContain('Забагато спроб. Спробуйте за 15 хвилин.');
});

test('POST /login with the right password sets the cookie and redirects to /', async () => {
  const pool = fakePool();
  const hash = await hashPassword('right');
  pool.on((t) => (t.includes('FROM attorney_crm_users WHERE email') ? [{ id: 1, email: 'v@legal.org.ua', display_name: 'V', password_hash: hash }] : undefined));
  const res = await request(appWith(pool)).post('/login').type('form').send({ email: 'v@legal.org.ua', password: 'right' });
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe('/');
  const cookie = String(res.headers['set-cookie']);
  expect(cookie).toMatch(/^acrm_session=/);
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('Secure');
  expect(cookie).toContain('SameSite=Lax');
  expect(pool.calls.some((c) => c.text.includes('INSERT INTO attorney_crm_sessions'))).toBe(true);
  expect(pool.calls.some((c) => c.text.includes('last_login_at'))).toBe(true);
});

test('GET /advocates with a session renders the table with filters and rows', async () => {
  const pool = fakePool();
  sessionFor(pool, 'tok');
  pool.on((t) => (t.includes('count(*)') ? [{ total: 1 }] : undefined));
  pool.on((t) => (t.includes('SELECT DISTINCT') ? [{ v: 'Київ' }] : undefined));
  pool.on((t) =>
    t.includes('FROM opendata_advocates a') && t.includes('LIMIT 50')
      ? [{ source_id: '42', family_name: 'Коваль', first_name: 'Іван', patronymic: 'Петрович', status: 'active', phone: '+38(044)1', email: 'k@x', city: 'Київ', region: 'м. Київ', org_forms: 'АО К', ra_name: 'РА Києва', certificate_num: '1/1', certificate_date: new Date('2010-01-01'), stage: 'interested', next_contact_at: null, manual_practices: ['ДТП'], last_contact: null, kind_cases: 5, kind_summary: '2:5' }]
      : undefined,
  );
  const res = await request(appWith(pool)).get('/advocates?justice_kind=2&sort=cases').set('Cookie', 'acrm_session=tok');
  expect(res.status).toBe(200);
  expect(res.text).toContain('Коваль Іван Петрович');
  expect(res.text).toContain('href="/advocates/42"');
  expect(res.text).toContain('Кримінальне · 5');
  expect(res.text).toContain('chip chip--manual');
  expect(res.text).toContain('Зацікавлений');
  expect(res.text).toContain('name="surname"');
  expect(res.text).toContain('<option value="Київ"');
  expect(res.text).toContain('Сторінка 1 з 1');
});

test('POST /logout clears the cookie and redirects to /login', async () => {
  const pool = fakePool();
  sessionFor(pool, 'tok');
  const res = await request(appWith(pool)).post('/logout').set('Cookie', 'acrm_session=tok');
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe('/login');
  expect(pool.calls.some((c) => c.text.startsWith('DELETE FROM attorney_crm_sessions'))).toBe(true);
});

test('unknown route renders a Ukrainian 404', async () => {
  const pool = fakePool();
  sessionFor(pool, 'tok');
  const res = await request(appWith(pool)).get('/nope').set('Cookie', 'acrm_session=tok');
  expect(res.status).toBe(404);
  expect(res.text).toContain('Сторінку не знайдено');
});
