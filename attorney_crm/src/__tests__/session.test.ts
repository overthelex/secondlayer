import { createHash } from 'crypto';
import { createSession, resolveSession, destroySession, COOKIE_NAME, cookieOptions } from '../auth/session';

type Call = { text: string; values?: unknown[] };

function fakePool(rows: Record<string, unknown>[] = []) {
  const calls: Call[] = [];
  return {
    calls,
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      if (text.startsWith('SELECT')) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 1 };
    },
  };
}

test('createSession stores sha256 of the cookie value, not the value, for 30 days', async () => {
  const pool = fakePool();
  const now = new Date('2026-11-07T00:00:00Z');
  const value = await createSession(pool as any, 7, now);
  expect(value.length).toBeGreaterThanOrEqual(43);
  const insert = pool.calls.find((c) => c.text.startsWith('INSERT'))!;
  expect(insert.values![0]).toBe(createHash('sha256').update(value).digest('hex'));
  expect(insert.values).not.toContain(value);
  expect(insert.values![1]).toBe(7);
  expect((insert.values![2] as Date).toISOString()).toBe('2026-12-07T00:00:00.000Z');
});

test('resolveSession returns the user for a live session', async () => {
  const pool = fakePool([{ id: 7, email: 'v@legal.org.ua', display_name: 'V', expires_at: new Date('2030-01-01') }]);
  const user = await resolveSession(pool as any, 'abc', new Date('2026-11-07'));
  expect(user).toEqual({ id: 7, email: 'v@legal.org.ua', displayName: 'V' });
});

test('resolveSession on an expired row deletes it and returns null', async () => {
  const pool = fakePool([{ id: 7, email: 'v@legal.org.ua', display_name: 'V', expires_at: new Date('2026-01-01') }]);
  const user = await resolveSession(pool as any, 'abc', new Date('2026-11-07'));
  expect(user).toBeNull();
  expect(pool.calls.some((c) => c.text.startsWith('DELETE'))).toBe(true);
});

test('resolveSession without a cookie does not query', async () => {
  const pool = fakePool();
  expect(await resolveSession(pool as any, undefined)).toBeNull();
  expect(pool.calls).toHaveLength(0);
});

test('destroySession deletes by hash; cookie options are strict', async () => {
  const pool = fakePool();
  await destroySession(pool as any, 'abc');
  expect(pool.calls[0].values![0]).toBe(createHash('sha256').update('abc').digest('hex'));
  expect(COOKIE_NAME).toBe('acrm_session');
  const o = cookieOptions();
  expect(o).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 3600 * 1000 });
});

import { parseCookies } from '../auth/cookies';
test('parseCookies reads the session cookie among others', () => {
  expect(parseCookies('a=1; acrm_session=xyz%3D; b=2')).toEqual({ a: '1', acrm_session: 'xyz=', b: '2' });
  expect(parseCookies(undefined)).toEqual({});
});
