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

describe('advocate page', () => {
  const advocateRow = { source_id: '42', family_name: 'Коваль', first_name: 'Іван', patronymic: 'Петрович', status: 'suspended', status_description: 'зупинено', phone: '+38(044)1', email: 'k@x', city: 'Київ', region: 'м. Київ', org_forms: 'АО К', ra_name: 'РА', certificate_num: '1/1', certificate_date: new Date('2010-01-01'), stage: null, next_contact_at: null, manual_practices: null, last_contact: null, kind_cases: 0, kind_summary: '1:10' };

  test('GET /advocates/:id renders registry card, profile, forms and notes; unknown id → 404', async () => {
    const pool = fakePool();
    sessionFor(pool, 'tok');
    pool.on((t, v) => (t.includes('WHERE a.source_id = $1') ? (v?.[0] === '42' ? [advocateRow] : []) : undefined));
    pool.on((t) => (t.includes('edrsr_cause_categories') ? [{ category_code: 1, name: 'Спори', cases: 4 }] : undefined));
    pool.on((t) => (t.includes('GROUP BY justice_kind ORDER BY') ? [{ justice_kind: 1, cases: 10, first_year: 2024, last_year: 2026 }] : undefined));
    pool.on((t) => (t.includes('FROM attorney_crm_notes n') && t.includes('JOIN attorney_crm_users') ? [{ id: 5, advocate_source_id: '42', user_id: 1, kind: 'call', body: 'Подзвонив <b>', created_at: new Date('2026-11-07T10:00:00Z'), author: 'V' }] : undefined));
    const res = await request(appWith(pool)).get('/advocates/42').set('Cookie', 'acrm_session=tok');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Коваль Іван Петрович');
    expect(res.text).toContain('<strong>Цивільне</strong>: 10 справ, 2024–2026');
    expect(res.text).toContain('Спори');
    expect(res.text).toContain('action="/advocates/42/lead"');
    expect(res.text).toContain('action="/advocates/42/notes"');
    expect(res.text).toContain('Подзвонив &lt;b&gt;');
    expect(res.text).toContain('status suspended');
    const nf = await request(appWith(pool)).get('/advocates/nope').set('Cookie', 'acrm_session=tok');
    expect(nf.status).toBe(404);
  });

  test('POST notes with a blank body → 400; valid note → redirect back', async () => {
    const pool = fakePool();
    sessionFor(pool, 'tok');
    pool.on((t) => (t.includes('WHERE a.source_id = $1') ? [advocateRow] : undefined));
    pool.on((t) => (t.includes('INSERT INTO attorney_crm_notes') ? [{ id: 1, advocate_source_id: '42', user_id: 1, kind: 'call', body: 'ok', created_at: new Date() }] : undefined));
    let res = await request(appWith(pool)).post('/advocates/42/notes').set('Cookie', 'acrm_session=tok').type('form').send({ kind: 'call', body: '   ' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('Порожня нотатка');
    res = await request(appWith(pool)).post('/advocates/42/notes').set('Cookie', 'acrm_session=tok').type('form').send({ kind: 'call', body: 'ok' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/advocates/42');
  });

  test('POST lead saves stage, date and practices; unknown practice → 400', async () => {
    const pool = fakePool();
    sessionFor(pool, 'tok');
    pool.on((t) => (t.includes('WHERE a.source_id = $1') ? [advocateRow] : undefined));
    pool.on((t) => (t.includes('INSERT INTO attorney_crm_leads') ? [{ advocate_source_id: '42', stage: 'interested', next_contact_at: new Date(), manual_practices: ['ДТП', 'Сімейне право'], assigned_user_id: null, updated_at: new Date(), updated_by: 1 }] : undefined));
    let res = await request(appWith(pool)).post('/advocates/42/lead').set('Cookie', 'acrm_session=tok').type('form')
      .send('stage=interested&next_contact_at=2026-11-10&manual_practices=ДТП&manual_practices=Сімейне право');
    expect(res.status).toBe(302);
    const ins = pool.calls.find((c) => c.text.includes('INSERT INTO attorney_crm_leads'))!;
    expect(ins.values![1]).toBe('interested');
    expect((ins.values![2] as Date).toISOString()).toBe('2026-11-09T22:00:00.000Z');
    expect(ins.values![3]).toEqual(['ДТП', 'Сімейне право']);
    res = await request(appWith(pool)).post('/advocates/42/lead').set('Cookie', 'acrm_session=tok').type('form').send({ stage: 'new', manual_practices: 'Космічне право' });
    expect(res.status).toBe(400);
  });
});

describe('today page', () => {
  test('GET / lists due leads (overdue marked) and recent notes', async () => {
    const pool = fakePool();
    sessionFor(pool, 'tok');
    pool.on((t) => (t.includes('l.next_contact_at < $1') ? [{ advocate_source_id: '42', family_name: 'Коваль', first_name: 'Іван', patronymic: 'П', city: 'Київ', phone: '+38(044)1', stage: 'contacted', next_contact_at: new Date('2020-01-01'), last_note: 'раніше', last_note_at: new Date() }] : undefined));
    pool.on((t) => (t.includes('ORDER BY n.created_at DESC') && t.includes('LIMIT $1') ? [{ id: 1, advocate_source_id: '42', kind: 'call', body: 'Домовились', created_at: new Date(), author: 'V', family_name: 'Коваль', first_name: 'Іван', patronymic: 'П' }] : undefined));
    const res = await request(appWith(pool)).get('/').set('Cookie', 'acrm_session=tok');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Подзвонити сьогодні');
    expect(res.text).toContain('Нові нотатки');
    expect(res.text).toContain('прострочено');
    expect(res.text).toContain('Домовились');
    expect(res.text).toContain('href="/advocates/42"');
  });
});
